# Rune Code 人机交互安全设计

本文档详细设计 Agent 的人机交互安全体系 —— 如何在保证效率的同时，防止 LLM 执行危险操作。

## 1. 现状分析

### 1.1 已实现：6 层安全防护

| 层 | 机制 | 位置 | 状态 |
|---|---|---|---|
| HITL 中间件 | 拦截所有 bash 调用，要求 approve/reject | `coding-agent.ts:55` | ✅ 已实现 |
| 危险规则引擎 | 60+ 条结构化规则，6 大分类，0-100 风险评分 | `safety/danger-engine.ts` | ✅ 已实现 |
| 分级审批 UI | safe 自动放行 / warning 1.2s 提示 / dangerous 审批弹窗 / critical 倒计时 | `app.tsx:174-248` | ✅ 已实现 |
| 白名单机制 | 19 条内置白名单（`rm -rf node_modules` 等常见无害操作） | `danger-engine.ts:418-439` | ✅ 已实现 |
| 工具描述警告 | prompt 层告知 LLM 不要执行危险操作 | `tool.ts` | ✅ 已实现 |
| 系统提示规则 | 不能访问用户未指定的路径 | `coding_agent.md` | ✅ 已实现 |

### 1.2 危险规则引擎（Layer 1）

位于 `src/safety/danger-engine.ts`，实现了结构化的规则引擎：

- **6 大分类**：`file_destruction`、`system_modification`、`network_danger`、`git_destructive`、`privilege_escalation`、`rce`
- **60+ 条规则**，每条包含正则模式 + 语义分类 + 0-100 风险评分 + 人类可读描述
- **白名单机制**：19 条内置白名单（`rm -rf node_modules`、`git status` 等），命中白名单直接 safe 放行
- **取最高分策略**：多个规则命中时取最高分（非累加），避免"多个低危 = 高危"的伪阳性

### 1.3 分级审批策略（Layer 2）

| 风险等级 | 分数范围 | 审批行为 |
|---------|---------|---------|
| `safe` | 0-29 | 自动放行，不打扰用户 |
| `warning` | 30-59 | 短暂提示 3 秒后自动执行 |
| `dangerous` | 60-89 | 审批弹窗：显示命令、风险类别、评分，Approve/Reject |
| `critical` | 90-100 | 审批弹窗 + "此命令可能对系统造成不可逆影响"警告 + 5 秒倒计时后才能 Approve |

审批 UI 组件位于 `app.tsx:332-430`，根据风险等级动态显示不同的边框颜色、图标和警告信息。

### 1.4 待解决问题

#### 问题一：text_editor 工具无拦截 ✅ 已规划

bash 有 HITL，但 `text_editor` 可以直接覆盖任何文件（包括 `~/.ssh/id_rsa`、`/etc/hosts`）而完全不触发确认。解决方案见第 9 节，通过 HITL middleware 的 predicate 对项目外/敏感路径拦截。

#### 问题二：没有路径边界硬限制

Agent 技术上可以 `cd /etc` 然后操作系统文件。系统提示只是"建议"，需要硬性限制。解决方案见第 4 节路径沙箱。

#### 问题三：没有编辑预览/撤销

- text_editor 的 `str_replace` 没有 diff 预览
- 批准的操作没有撤销/回滚机制
- 一旦批准，无法挽回

#### 问题四：LangChain HITL 中间件已知 Bug

当 LLM 单次响应中包含多个 tool_call（如 `grep` + `bash`），且用户 reject 了 bash 时，langchain v1.4.2 的 HITL 中间件会把自动放行的 tool_call（grep）保留在 AIMessage 中但不生成对应 ToolMessage，导致 LLM API 400 错误。当前通过将 `allowedDecisions` 扩展为 `['approve', 'edit', 'reject']`，reject 时改用 `edit` 将命令替换为无害 `echo` 来绕过此 bug。详见 `app.tsx:287-320`。

---

## 2. 设计目标

1. **从"建议"到"硬限制"** —— 不靠 prompt 约束，靠代码 enforce
2. **从"二元审批"到"分级审批"** —— 降低审批疲劳，提升安全性
3. **从"只看命令"到"看影响"** —— 告诉用户这条命令到底会改什么
4. **可扩展性** —— 支持用户自定义规则
5. **可撤销** —— 关键操作有回滚能力

---

## 3. 整体架构

```
用户请求
    │
    ▼
┌─────────────────────────────────────────────┐
│ Layer 0: 沙箱/路径边界 (硬限制)                │
│   - 强制限制工作目录与白名单路径               │
│   - 禁止访问系统关键路径                       │
│   - 通过 execa 的 cwd 强制锁定                │
└──────────────────────┬──────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────┐
│ Layer 1: 危险命令分类 + 风险评分               │
│   - 维护危险命令知识库(正则 + 语义分类)         │
│   - 每个命令计算风险分数(0-100)                │
│   - 分类: safe | warning | dangerous | critical│
└──────────────────────┬──────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────┐
│ Layer 2: 上下文感知的审批策略                   │
│   - safe: 自动放行                            │
│   - warning: 静默记录，首次出现提示             │
│   - dangerous: 审批 UI + 显示影响预览          │
│   - critical: 二次确认 + 倒计时               │
│   - 支持「编辑后执行」                          │
└──────────────────────┬──────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────┐
│ Layer 3: 执行前预览 + 影响分析                  │
│   - 文件操作: 显示 diff                       │
│   - shell: 预估影响的文件列表                  │
│   - 列出会创建/修改/删除的文件                  │
└──────────────────────┬──────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────┐
│ Layer 4: 执行 + 回滚能力                      │
│   - 记录变更(文件快照)                         │
│   - 提供 /undo 命令回滚                       │
│   - 审计日志                                  │
└─────────────────────────────────────────────┘
```

---

## 4. Layer 0: 路径沙箱

系统提示中的"不要访问项目外文件"只是软约束。需要硬编码的路径校验。

### 4.1 实现

```typescript
// src/safety/path-sandbox.ts

import path from 'path';
import os from 'os';

const PROJECT_ROOT = process.env.PROJECT_DIR || process.cwd();
const HOME = os.homedir();

/** 默认阻止的前缀（在项目外时） */
const BLOCKED_PREFIXES = [
    '/etc', '/proc', '/sys', '/dev',
    '/root', '/var/log', '/boot',
    path.join(HOME, '.ssh'),
    path.join(HOME, '.aws'),
    path.join(HOME, '.gnupg'),
    path.join(HOME, '.config'),
];

/** 用户配置的额外允许路径 */
let extraAllowedPaths: string[] = [];

export function configureSandbox(options: { allowedPaths?: string[] }) {
    if (options.allowedPaths) {
        extraAllowedPaths = options.allowedPaths.map(p => path.resolve(p));
    }
}

/**
 * 校验目标路径是否安全可访问。
 * 返回 { allowed: true } 或 { allowed: false, reason: string }
 */
export function validatePath(targetPath: string): PathValidation {
    const resolved = path.resolve(targetPath);

    // 项目内一律放行
    if (resolved.startsWith(PROJECT_ROOT)) {
        return { allowed: true };
    }

    // 额外的用户白名单路径
    if (extraAllowedPaths.some(p => resolved.startsWith(p))) {
        return { allowed: true };
    }

    // 阻止的系统路径
    for (const blocked of BLOCKED_PREFIXES) {
        if (resolved.startsWith(blocked)) {
            return {
                allowed: false,
                reason: `Path "${targetPath}" is in blocked system directory "${blocked}"`,
            };
        }
    }

    // 项目外的非系统路径：只读允许，写入需要配置
    return {
        allowed: true,
        warning: `Path "${targetPath}" is outside the project directory. Write operations will be logged.`,
    };
}
```

### 4.2 集成点

- `BashTerminal` 执行命令前调用 `validatePath(cwd)`，如果 cwd 本身不合法则拒绝
- `text_editor` 的 `create`/`str_replace` 操作前校验 `filePath`
- `ls`、`tree`、`grep` 工具在非项目路径前给出 warning 但仍允许读取

---

## 5. Layer 1: 危险命令知识库

不再是一个简单正则，而是结构化的规则引擎。

### 5.1 数据模型

```typescript
// src/safety/danger-rule-engine.ts

interface DangerRule {
    /** 正则表达式 */
    pattern: RegExp;
    /** 语义分类 */
    category: DangerCategory;
    /** 风险分数 0-100 */
    riskScore: number;
    /** 人类可读描述 */
    description: string;
}

type DangerCategory =
    | 'file_destruction'      // 文件/数据删除
    | 'system_modification'   // 系统配置修改
    | 'network_danger'        // 网络相关危险
    | 'git_destructive'       // Git 破坏性操作
    | 'privilege_escalation'  // 权限提升
    | 'rce';                  // 远程代码执行

interface DangerAssessment {
    level: 'safe' | 'warning' | 'dangerous' | 'critical';
    score: number;
    matchedRules: DangerRule[];
    category: DangerCategory | null;
    description: string | null;
}

/** 风险等级 → 阈值映射 */
const RISK_THRESHOLDS = {
    critical: 90,   // 90+ : 对系统有不可逆影响
    dangerous: 60,  // 60-89: 对项目有不可逆影响
    warning: 30,    // 30-59: 可能有意料外的副作用
    safe: 0,        // 0-29: 安全
};
```

### 5.2 规则库

```typescript
const DANGER_RULES: DangerRule[] = [
    // ── 文件销毁 ──
    { pattern: /\brm\s+-rf?\s+\/\b/,          category: 'file_destruction',     riskScore: 100, description: '递归强制删除根目录' },
    { pattern: /\brm\s+-rf?\s+~\//,            category: 'file_destruction',     riskScore: 95,  description: '递归强制删除 home 目录' },
    { pattern: /\brm\s+-rf?\b/,                 category: 'file_destruction',     riskScore: 85,  description: '递归强制删除文件/目录' },
    { pattern: /\brm\b/,                        category: 'file_destruction',     riskScore: 60,  description: '删除文件或目录' },
    { pattern: /\brmdir\b/,                     category: 'file_destruction',     riskScore: 50,  description: '删除空目录' },
    { pattern: /\bfind\b.*\b-delete\b/,         category: 'file_destruction',     riskScore: 85,  description: 'find + delete 批量删除' },
    { pattern: /\bmv\b.*\/dev\/null/,           category: 'file_destruction',     riskScore: 80,  description: '移动文件到 /dev/null（等效删除）' },
    { pattern: /\b>\/dev\/null\b/,              category: 'file_destruction',     riskScore: 60,  description: '输出重定向到 /dev/null' },

    // ── 系统修改 ──
    { pattern: /\bdd\b/,                        category: 'system_modification',  riskScore: 95,  description: '低级磁盘操作（dd）' },
    { pattern: /\bmkfs\b/,                      category: 'system_modification',  riskScore: 100, description: '创建文件系统（格式化）' },
    { pattern: /\bchmod\s+.*(777|o\+w|a\+w)/,   category: 'system_modification',  riskScore: 75,  description: '修改为危险权限' },
    { pattern: /\bchmod\s+-\w*R\w*\s+\//,       category: 'system_modification',  riskScore: 90,  description: '递归修改根目录权限' },
    { pattern: /\bchown\s+-R\b/,                category: 'system_modification',  riskScore: 70,  description: '递归修改文件所有者' },
    { pattern: /\b(chown|chgrp)\b/,             category: 'system_modification',  riskScore: 50,  description: '修改文件所有者/组' },
    { pattern: /export\s+.*>>\s+~(.*bashrc|.*profile|.*zshrc)/,
                                                 category: 'system_modification',  riskScore: 80,  description: '修改 shell 配置文件' },

    // ── 系统控制 ──
    { pattern: /\b(shutdown|reboot|halt|poweroff|init\s+[06])\b/,
                                                 category: 'system_modification',  riskScore: 90,  description: '系统关机/重启' },
    { pattern: /\b(kill|pkill|killall)\b/,      category: 'system_modification',  riskScore: 55,  description: '终止进程' },
    { pattern: /\b(kill|pkill)\s+-9\b/,         category: 'system_modification',  riskScore: 70,  description: '强制终止进程（SIGKILL）' },

    // ── Git 破坏 ──
    { pattern: /\bgit\s+push\s+--force(-with-lease)?/, category: 'git_destructive', riskScore: 80,  description: '强制推送' },
    { pattern: /\bgit\s+push\s+.*--delete\b/,   category: 'git_destructive',      riskScore: 85,  description: '删除远程分支' },
    { pattern: /\bgit\s+reset\s+--hard\b/,      category: 'git_destructive',      riskScore: 70,  description: '硬重置（丢弃修改）' },
    { pattern: /\bgit\s+clean\s+-[fdx]+/,       category: 'git_destructive',      riskScore: 55,  description: '清理未追踪文件' },
    { pattern: /\bgit\s+checkout\s+--\s/,       category: 'git_destructive',      riskScore: 40,  description: '丢弃文件修改' },
    { pattern: /\bgit\s+stash\s+drop\b/,        category: 'git_destructive',      riskScore: 40,  description: '删除 stash' },
    { pattern: /\bgit\s+rebase\s+-i\b/,         category: 'git_destructive',      riskScore: 60,  description: '交互式 rebase（不可交互环境）' },

    // ── RCE / 供应链攻击 ──
    { pattern: /\bcurl\b.*\|\s*(ba)?sh\b/,     category: 'rce',                  riskScore: 100, description: 'curl 管道到 shell——供应链攻击' },
    { pattern: /\bwget\b.*\|\s*(ba)?sh\b/,     category: 'rce',                  riskScore: 100, description: 'wget 管道到 shell——供应链攻击' },
    { pattern: /\bcurl\b.*-o\s+.*\.sh/,         category: 'rce',                  riskScore: 70,  description: '下载并保存 shell 脚本' },
    { pattern: /\beval\b.*\$/,                  category: 'rce',                  riskScore: 80,  description: '动态执行代码（eval）' },
    { pattern: /\bsource\s+\/dev\/tcp\//,       category: 'rce',                  riskScore: 100, description: '反向 shell 连接' },
    { pattern: /\bnc\s+.*-e\s/,                category: 'rce',                  riskScore: 95,  description: 'netcat 反向 shell' },

    // ── 权限提升 ──
    { pattern: /\bsudo\b/,                      category: 'privilege_escalation', riskScore: 75,  description: '使用 sudo 提权' },
    { pattern: /\bsudo\s+su\b/,                 category: 'privilege_escalation', riskScore: 90,  description: '切换到 root' },
    { pattern: /\bsu\s+-\b/,                    category: 'privilege_escalation', riskScore: 85,  description: '切换到 root 登录 shell' },

    // ── Docker / K8s ──
    { pattern: /\bdocker\s+rm\s+-f\b/,          category: 'system_modification',  riskScore: 75,  description: '强制删除容器' },
    { pattern: /\bdocker\s+system\s+prune/,     category: 'system_modification',  riskScore: 75,  description: '清理 Docker 系统资源' },
    { pattern: /\bdocker\s+rmi\s+-f\b/,         category: 'system_modification',  riskScore: 70,  description: '强制删除镜像' },
    { pattern: /\bkubectl\s+delete/,            category: 'system_modification',  riskScore: 85,  description: '删除 Kubernetes 资源' },
    { pattern: /\bkubectl\s+apply/,             category: 'system_modification',  riskScore: 50,  description: '修改 Kubernetes 资源' },
    { pattern: /\bhelm\s+uninstall\b/,          category: 'system_modification',  riskScore: 70,  description: '卸载 Helm release' },

    // ── 权限修改 ──
    { pattern: /\bchmod\s+-R\b/,                category: 'system_modification',  riskScore: 55,  description: '递归修改文件权限' },
    { pattern: /\bchmod\b/,                     category: 'system_modification',  riskScore: 30,  description: '修改文件权限' },

    // ── 网络危险 ──
    { pattern: /\biptables\s+-F\b/,            category: 'network_danger',       riskScore: 85,  description: '清空防火墙规则' },
    { pattern: /\biptables\b/,                  category: 'network_danger',       riskScore: 60,  description: '修改防火墙规则' },
    { pattern: /\bufw\s+disable\b/,             category: 'network_danger',       riskScore: 80,  description: '禁用防火墙' },
    { pattern: /\bssh-copy-id\b/,              category: 'network_danger',       riskScore: 60,  description: '复制 SSH 密钥到远程' },
];
```

### 5.3 风险评估函数

```typescript
export function assessRisk(command: string): DangerAssessment {
    const matches: DangerRule[] = [];

    for (const rule of DANGER_RULES) {
        if (rule.pattern.test(command)) {
            matches.push(rule);
        }
    }

    if (matches.length === 0) {
        return { level: 'safe', score: 0, matchedRules: [], category: null, description: null };
    }

    // 取最高分规则（不是累加，避免"蚂蚁咬死象"的问题）
    const maxRule = matches.reduce((a, b) => a.riskScore > b.riskScore ? a : b);

    const level: DangerAssessment['level'] =
        maxRule.riskScore >= RISK_THRESHOLDS.critical ? 'critical'
        : maxRule.riskScore >= RISK_THRESHOLDS.dangerous ? 'dangerous'
        : maxRule.riskScore >= RISK_THRESHOLDS.warning ? 'warning'
        : 'safe';

    return {
        level,
        score: maxRule.riskScore,
        matchedRules: matches,
        category: maxRule.category,
        description: maxRule.description,
    };
}
```

---

## 6. Layer 2: 分级审批策略

### 6.1 策略表

| 风险等级 | 分数范围 | 审批行为 |
|---------|---------|---------|
| `safe` | 0-29 | 自动执行，不打扰用户 |
| `warning` | 30-59 | 记录日志，在 UI 底部显示一则提示，3 秒后自动执行 |
| `dangerous` | 60-89 | 审批弹窗 + 显示影响范围 + [Edit] [Approve] [Reject] |
| `critical` | 90-100 | 二次确认弹窗 "你真的确定？" + 5 秒倒计时后才能点 Approve |

### 6.2 审批 UI 设计

#### dangerous 级别：

```
┌─ ⚠  Dangerous Command (risk: 75) ──────────┐
│ Type:     git_destructive                   │
│ Command:  git reset --hard HEAD~3           │
│ Category: git_destructive                   │
│ Affects:  会丢弃最近 3 次 commit             │
│                                              │
│ ┌─ Preview ─────────────────────────────┐   │
│ │ This will discard:                     │   │
│ │  abc123 feat: new feature              │   │
│ │  def456 fix: bug fix                   │   │
│ │  ghi789 chore: cleanup                 │   │
│ └───────────────────────────────────────┘   │
│                                              │
│ [Edit & Run]  [Approve]  [Reject]            │
└──────────────────────────────────────────────┘
```

#### critical 级别：

```
┌─ 🛑 CRITICAL Command (risk: 95) ────────────┐
│ Type:     system_modification                │
│ Command:  sudo rm -rf /some/path             │
│ Warning:  此命令可能对系统造成不可逆影响       │
│                                              │
│ 确认请输入 "yes, I understand the risks":    │
│ > █                                          │
│                                              │
│ [Approve] (5s)  [Reject]                     │
└──────────────────────────────────────────────┘
```

### 6.3 编辑后执行（Edit & Run）

用户选了 Edit & Run 后：

1. 审批弹窗关闭，切换到编辑模式
2. 命令文本出现在输入框顶部，用户可以直接修改
3. 修改后按 Enter 提交，进入二次评估流程（以防用户改出了更危险的命令）
4. 评估通过后执行

### 6.4 白名单机制

```typescript
// src/safety/whitelist.ts

interface WhitelistEntry {
    pattern: string;        // 精确匹配或 glob
    riskScore: number;      // 覆盖后的分数（设为 0 即永远自动放行）
}

// 内置白名单（常见无害操作，即使命中了危险规则也放行）
const BUILTIN_WHITELIST: WhitelistEntry[] = [
    { pattern: 'rm -rf node_modules', riskScore: 0 },
    { pattern: 'rm -rf dist', riskScore: 0 },
    { pattern: 'rm -rf .next', riskScore: 0 },
    { pattern: 'rm -rf build', riskScore: 0 },
    { pattern: 'rm -rf coverage', riskScore: 0 },
    { pattern: 'rm -rf *.log', riskScore: 0 },
    { pattern: 'git status', riskScore: 0 },
    { pattern: 'rm -rf .turbo', riskScore: 0 },
    { pattern: 'rm -rf .cache', riskScore: 0 },
];
```

### 6.5 用户自定义规则

支持用户在项目根目录放置 `.rune-code-safety.yaml`：

```yaml
# .rune-code-safety.yaml

safety:
  # 需要额外确认的工具（text_editor 默认无 HITL，可以在这里开启）
  additional_hitl_tools:
    - text_editor

  # 路径白名单（允许访问的项目外路径）
  allowed_paths:
    - ~/Downloads/tmp
    - /tmp/rune-code

  # 项目外只读（禁止修改项目外的任何文件）
  read_only_outside_project: true

  # 命令白名单（覆盖危险规则评分）
  command_whitelist:
    - pattern: "rm -rf node_modules"
      reason: "标准清理操作"
    - pattern: "rm -rf dist"
      reason: "构建产物清理"
    - pattern: "git status"
      reason: "只读操作"

  # 命令黑名单（强制拦截，即使不在危险规则库中）
  command_blacklist:
    - pattern: "git push --force origin main"
      message: "禁止强制推送到 main 分支"
    - pattern: "npm publish"
      message: "请手动执行发布操作"

  # 自定义危险规则（追加到内置规则库）
  custom_rules:
    - pattern: "npm unpublish"
      score: 95
      description: "从 npm 注销包（不可逆）"

  # 审批策略调整
  approval:
    # 哪些分类自动放行（覆盖规则评分）
    auto_approve_categories: []
    # critical 级别的倒计时秒数
    critical_cooldown_seconds: 5
```

---

## 7. Layer 3: 执行前预览

### 7.1 text_editor 操作预览

在执行 `str_replace` 前显示 diff：

```typescript
// src/safety/preview.ts

import { diffLines } from 'diff';

interface EditPreview {
    kind: 'create' | 'overwrite' | 'str_replace' | 'insert';
    filePath: string;
    /** 原始内容（修改前） */
    original?: string;
    /** 修改后内容 */
    modified: string;
    /** Unified diff 文本 */
    diff?: string;
}

export function previewEdit(params: {
    filePath: string;
    command: 'view' | 'create' | 'str_replace' | 'insert';
    fileText?: string;
    oldStr?: string;
    newStr?: string;
    insertLine?: number;
}): EditPreview {
    const { filePath, command } = params;

    switch (command) {
        case 'create': {
            return {
                kind: 'create',
                filePath,
                modified: params.fileText!,
                diff: `+ (new file)\n${params.fileText!.split('\n').map(l => `+ ${l}`).join('\n')}`,
            };
        }
        case 'str_replace': {
            const original = fs.readFileSync(filePath, 'utf-8');
            const modified = original.replace(params.oldStr!, params.newStr!);
            const diff = diffLines(original, modified)
                .map(part => {
                    const prefix = part.added ? '+' : part.removed ? '-' : ' ';
                    return part.value.split('\n').filter(Boolean).map(l => `${prefix} ${l}`).join('\n');
                })
                .join('\n');

            return {
                kind: 'str_replace',
                filePath,
                original,
                modified,
                diff,
            };
        }
        case 'insert': {
            // 类似 str_replace 的逻辑
        }
        case 'view': {
            return { kind: 'view' as any, ... };
        }
    }
}
```

### 7.2 Shell 命令影响预览

在执行危险命令前，尝试分析命令会影响哪些文件：

```typescript
export function analyzeCommandImpact(command: string, cwd: string): CommandImpact {
    return {
        cwd,
        command,
        // 通过解析命令参数来预估影响的文件
        affectedPaths: extractPaths(command, cwd),
        // 标志位分析
        flags: {
            recursive: /-r\b|--recursive/.test(command),
            force: /-f\b|--force/.test(command),
            dryRun: /--dry-run|--check/.test(command),
            sudo: /\bsudo\b/.test(command),
        },
    };
}
```

---

## 8. Layer 4: 审计与回滚

### 8.1 变更记录

```typescript
// src/safety/change-log.ts

interface ChangeRecord {
    id: string;
    timestamp: number;
    tool: 'bash' | 'text_editor';
    file: string;           // 影响的文件路径
    before?: string;        // 修改前内容（文本文件）
    after?: string;         // 修改后内容
    command: string;        // 完整的工具调用参数
    assessment: DangerAssessment;
    reverted: boolean;
}

class ChangeLog {
    private records: ChangeRecord[] = [];
    private maxRecords = 100;

    record(change: Omit<ChangeRecord, 'id' | 'timestamp' | 'reverted'>): string {
        const id = crypto.randomUUID();
        this.records.push({
            ...change,
            id,
            timestamp: Date.now(),
            reverted: false,
        });
        // 保留最近 N 条
        if (this.records.length > this.maxRecords) {
            this.records = this.records.slice(-this.maxRecords);
        }
        return id;
    }

    rollback(changeId: string): boolean {
        const record = this.records.find(r => r.id === changeId);
        if (!record || record.reverted || !record.before) return false;

        // 恢复文件
        fs.writeFileSync(record.file, record.before);
        record.reverted = true;
        return true;
    }

    getRecent(): ChangeRecord[] {
        return this.records;
    }
}

export const changeLog = new ChangeLog();
```

### 8.2 /undo 命令

用户可以在对话中键入 `/undo` 来触发回滚：

```
/undo        回滚最近一次文件修改操作
/undo list   列出最近的操作
/undo <id>   回滚指定操作
/undo all    回滚本次会话所有修改
```

---

## 9. text_editor 纳入 HITL

### 9.1 配置化拦截

```typescript
// src/agents/coding-agent.ts

humanInTheLoopMiddleware({
    interruptOn: {
        bash: {
            allowedDecisions: ['approve', 'reject'],
            description: 'Shell command execution',
        },
        // 新增：对项目外或敏感路径的 text_editor 操作也拦截
        text_editor: {
            allowedDecisions: ['approve', 'reject', 'edit'],
            // 使用自定义 predicate 决定何时触发
            interruptPredicate: (action) => {
                const targetPath = action.args.path;
                if (!targetPath) return false;

                const validation = validatePath(targetPath);

                // 项目内安全路径：不拦截
                if (validation.allowed && !validation.warning) {
                    return false;
                }

                // 项目外或敏感路径：拦截
                return true;
            },
        },
    },
}),
```

### 9.2 分级策略

| 操作类型 | 位置 | 行为 |
|---------|------|------|
| `view` | 任意 | 永不拦截 |
| `create` | 项目内 | 不拦截 |
| `create` | 项目外 | 审批 + 路径警告 |
| `str_replace` | 项目内 | 显示 diff，不拦截（除非开启配置）|
| `str_replace` | 项目外 | 审批 + diff + 路径警告 |
| `insert` | 同 str_replace | |

---

## 10. 改进优先级

### 10.1 已完成

| 改进项 | 实现 | 文件 |
|--------|------|------|
| 扩展危险命令规则库（60+ 规则） | ✅ | `src/safety/danger-engine.ts` |
| 分级审批 UI（safe/warning/dangerous/critical） | ✅ | `src/cli/app.tsx:174-430` |
| 白名单机制（19 条内置白名单） | ✅ | `src/safety/danger-engine.ts:418-439` |

### 10.2 待完成

| 优先级 | 改进项 | 工作量 | 原因 |
|--------|--------|--------|------|
| **P0** | text_editor 加路径校验 | 小 | 静默修改安全漏洞，影响面大 |
| **P1** | 编辑后执行（Edit & Run） | 中 | 提升效率，减少用户重复输入 |
| **P1** | reject 改 edit 绕过 LangChain HITL bug | 小 | 防止 400 错误 |
| **P2** | 执行前预览（diff + 影响分析） | 中 | 提升审批透明度 |
| **P2** | 路径沙箱硬限制 | 中 | 从建议改为强制执行 |
| **P3** | 用户自定义 `.rune-code-safety.yaml` | 大 | 个性化，需要文档和维护 |
| **P3** | 审计日志 + /undo 回滚 | 大 | 安全网，但实现成本高 |

---

## 11. 关键文件

| 文件 | 职责 | 状态 |
|------|------|------|
| `src/safety/danger-engine.ts` | 危险规则引擎：60+ 规则库 + 风险评估 + 白名单 | ✅ 已实现 |
| `src/cli/app.tsx` | HITL 中断处理 + 分级审批 UI + handleResume | ✅ 已实现 |
| `src/agents/coding-agent.ts` | HITL 中间件配置（bash 拦截） | ✅ 已实现 |
| `src/safety/path-sandbox.ts` | 路径沙箱：硬编码路径校验 | ❌ 待实现 |
| `src/safety/preview.ts` | 执行前预览：diff 生成 + 影响分析 | ❌ 待实现 |
| `src/safety/change-log.ts` | 变更记录与回滚 | ❌ 待实现 |

---

_最后更新：2026-05-31_