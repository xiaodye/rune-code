/**
 * 危险命令规则引擎
 *
 * 替代原来单一的正则 /(^|[;&|\s])(rm|rmdir)(\s|$)/
 * 采用结构化规则库 + 风险评分 + 白名单的三层模型。
 *
 * 风险等级：
 *   safe      (0-29)  → 自动放行
 *   warning   (30-59) → 短暂提示后自动执行
 *   dangerous (60-89) → 审批弹窗
 *   critical  (90-100)→ 二次确认 + 倒计时
 */

export type DangerCategory =
    | 'file_destruction'
    | 'system_modification'
    | 'network_danger'
    | 'git_destructive'
    | 'privilege_escalation'
    | 'rce';

export interface DangerRule {
    /** 正则表达式 */
    pattern: RegExp;
    /** 语义分类 */
    category: DangerCategory;
    /** 风险分数 0-100 */
    riskScore: number;
    /** 人类可读描述 */
    description: string;
}

export interface DangerAssessment {
    level: 'safe' | 'warning' | 'dangerous' | 'critical';
    score: number;
    matchedRules: DangerRule[];
    description: string | null;
    category: DangerCategory | null;
}

// ─── 风险等级阈值 ───────────────────────────────────────

const CRITICAL_THRESHOLD = 90;
const DANGEROUS_THRESHOLD = 60;
const WARNING_THRESHOLD = 30;

// ─── 危险规则库 ──────────────────────────────────────────

const DANGER_RULES: DangerRule[] = [
    // ═══ 文件销毁 ═══
    {
        pattern: /\brm\s+-rf?\s+\/\b/,
        category: 'file_destruction',
        riskScore: 100,
        description: '递归强制删除根目录',
    },
    {
        pattern: /\brm\s+-rf?\s+~\//,
        category: 'file_destruction',
        riskScore: 95,
        description: '递归强制删除 home 目录',
    },
    {
        pattern: /\brm\s+-rf?\b/,
        category: 'file_destruction',
        riskScore: 85,
        description: '递归强制删除文件/目录',
    },
    {
        pattern: /\brm\b/,
        category: 'file_destruction',
        riskScore: 60,
        description: '删除文件或目录',
    },
    {
        pattern: /\brmdir\b/,
        category: 'file_destruction',
        riskScore: 45,
        description: '删除空目录',
    },
    {
        pattern: /\bfind\b.*\b-delete\b/,
        category: 'file_destruction',
        riskScore: 85,
        description: 'find + delete 批量删除文件',
    },
    {
        pattern: /\bmv\b.*\/dev\/null/,
        category: 'file_destruction',
        riskScore: 80,
        description: '移动文件到 /dev/null（等效删除）',
    },
    {
        pattern: />\s*\/dev\/null/,
        category: 'file_destruction',
        riskScore: 60,
        description: '输出重定向覆盖 /dev/null',
    },
    {
        pattern: /\b(>|>>)\s*\/dev\/sda/,
        category: 'file_destruction',
        riskScore: 95,
        description: '写入磁盘设备（可能损坏文件系统）',
    },

    // ═══ 系统修改 ═══
    {
        pattern: /\bdd\b/,
        category: 'system_modification',
        riskScore: 95,
        description: '低级磁盘操作（dd）',
    },
    {
        pattern: /\bmkfs\b/,
        category: 'system_modification',
        riskScore: 100,
        description: '创建文件系统（格式化磁盘）',
    },
    {
        pattern: /\bchmod\s+.*(777|o\+w|a\+w)/,
        category: 'system_modification',
        riskScore: 75,
        description: '设置危险的全局可写权限',
    },
    {
        pattern: /\bchmod\s+-\w*R\w*\s+\//,
        category: 'system_modification',
        riskScore: 90,
        description: '递归修改根目录权限',
    },
    {
        pattern: /\bchown\s+-R\b/,
        category: 'system_modification',
        riskScore: 70,
        description: '递归修改文件所有者',
    },
    {
        pattern: /\b(chown|chgrp)\b/,
        category: 'system_modification',
        riskScore: 45,
        description: '修改文件所有者或组',
    },
    {
        pattern: /export\s+.*>>\s+~(.*bashrc|.*profile|.*zshrc)/,
        category: 'system_modification',
        riskScore: 80,
        description: '修改 shell 配置文件（可能植入后门）',
    },
    {
        pattern: /\/etc\/(hosts|passwd|shadow|sudoers|fstab)/,
        category: 'system_modification',
        riskScore: 90,
        description: '操作系统关键配置文件',
    },

    // ═══ 系统控制 ═══
    {
        pattern: /\b(shutdown|reboot|halt|poweroff|init\s+[06])\b/,
        category: 'system_modification',
        riskScore: 90,
        description: '系统关机或重启',
    },
    {
        pattern: /\b(kill|pkill)\s+-9\b/,
        category: 'system_modification',
        riskScore: 70,
        description: '强制终止进程（SIGKILL）',
    },
    {
        pattern: /\b(kill|pkill|killall)\b/,
        category: 'system_modification',
        riskScore: 50,
        description: '终止进程',
    },
    {
        pattern: /\bsystemctl\s+(stop|disable|mask)\b/,
        category: 'system_modification',
        riskScore: 70,
        description: '停止或禁用系统服务',
    },
    {
        pattern: /\blaunchctl\s+(unload|remove)\b/,
        category: 'system_modification',
        riskScore: 65,
        description: '卸载或移除 macOS 服务',
    },

    // ═══ Git 破坏性操作 ═══
    {
        pattern: /\bgit\s+push\s+--force(-with-lease)?\s+origin\s+(main|master)\b/,
        category: 'git_destructive',
        riskScore: 90,
        description: '强制推送到主分支',
    },
    {
        pattern: /\bgit\s+push\s+--force(-with-lease)?\b/,
        category: 'git_destructive',
        riskScore: 75,
        description: '强制推送',
    },
    {
        pattern: /\bgit\s+push\b.*\b--delete\b/,
        category: 'git_destructive',
        riskScore: 85,
        description: '删除远程分支',
    },
    {
        pattern: /\bgit\s+reset\s+--hard\b/,
        category: 'git_destructive',
        riskScore: 70,
        description: '硬重置（不可逆丢失修改）',
    },
    {
        pattern: /\bgit\s+clean\s+-[fdx]+/,
        category: 'git_destructive',
        riskScore: 55,
        description: '清理未追踪文件',
    },
    {
        pattern: /\bgit\s+checkout\s+--\s/,
        category: 'git_destructive',
        riskScore: 35,
        description: '丢弃文件的未暂存修改',
    },
    {
        pattern: /\bgit\s+stash\s+drop\b/,
        category: 'git_destructive',
        riskScore: 35,
        description: '删除 stash 条目',
    },
    {
        pattern: /\bgit\s+rebase\s+-i\b/,
        category: 'git_destructive',
        riskScore: 55,
        description: '交互式 rebase（不可交互环境中有风险）',
    },

    // ═══ RCE / 供应链攻击 ═══
    {
        pattern: /\bcurl\b.*\|\s*(ba)?sh\b/,
        category: 'rce',
        riskScore: 100,
        description: 'curl 管道到 shell——供应链攻击',
    },
    {
        pattern: /\bwget\b.*\|\s*(ba)?sh\b/,
        category: 'rce',
        riskScore: 100,
        description: 'wget 管道到 shell——供应链攻击',
    },
    {
        pattern: /\bcurl\b.*-o\s+.*\.sh\b/,
        category: 'rce',
        riskScore: 65,
        description: '下载 shell 脚本到文件',
    },
    {
        pattern: /\beval\b/,
        category: 'rce',
        riskScore: 80,
        description: '动态执行命令（eval）',
    },
    {
        pattern: /\bsource\s+\/dev\/tcp\//,
        category: 'rce',
        riskScore: 100,
        description: '反向 shell 连接',
    },
    {
        pattern: /\bnc\b.*-e\s/,
        category: 'rce',
        riskScore: 95,
        description: 'netcat 反向 shell',
    },
    {
        pattern: /\bbash\s+-c\b.*\$\(/,
        category: 'rce',
        riskScore: 75,
        description: '嵌套命令执行（可疑模式）',
    },

    // ═══ 权限提升 ═══
    {
        pattern: /\bsudo\s+su\b/,
        category: 'privilege_escalation',
        riskScore: 90,
        description: '切换到 root 用户',
    },
    {
        pattern: /\bsu\s+-\b/,
        category: 'privilege_escalation',
        riskScore: 85,
        description: '切换到 root 登录 shell',
    },
    {
        pattern: /\bsudo\b/,
        category: 'privilege_escalation',
        riskScore: 70,
        description: '使用 sudo 提权执行',
    },

    // ═══ Docker / K8s ═══
    {
        pattern: /\bdocker\s+rm\s+-f\b/,
        category: 'system_modification',
        riskScore: 75,
        description: '强制删除容器',
    },
    {
        pattern: /\bdocker\s+system\s+prune\b/,
        category: 'system_modification',
        riskScore: 75,
        description: '清理所有 Docker 系统资源',
    },
    {
        pattern: /\bdocker\s+rmi\s+-f\b/,
        category: 'system_modification',
        riskScore: 70,
        description: '强制删除 Docker 镜像',
    },
    {
        pattern: /\bdocker\s+volume\s+prune\b/,
        category: 'system_modification',
        riskScore: 65,
        description: '清理所有未使用的 Docker 卷',
    },
    {
        pattern: /\bkubectl\s+delete\b/,
        category: 'system_modification',
        riskScore: 85,
        description: '删除 Kubernetes 资源',
    },
    {
        pattern: /\bhelm\s+uninstall\b/,
        category: 'system_modification',
        riskScore: 70,
        description: '卸载 Helm release',
    },

    // ═══ 网络危险 ═══
    {
        pattern: /\biptables\s+-F\b/,
        category: 'network_danger',
        riskScore: 85,
        description: '清空防火墙规则',
    },
    {
        pattern: /\biptables\b/,
        category: 'network_danger',
        riskScore: 60,
        description: '修改防火墙规则',
    },
    {
        pattern: /\bufw\s+disable\b/,
        category: 'network_danger',
        riskScore: 80,
        description: '禁用防火墙',
    },
    {
        pattern: /\bssh-copy-id\b/,
        category: 'network_danger',
        riskScore: 55,
        description: '复制 SSH 公钥到远程主机',
    },

    // ═══ 权限修改 ═══
    {
        pattern: /\bchmod\s+-R\b/,
        category: 'system_modification',
        riskScore: 55,
        description: '递归修改文件权限',
    },
    {
        pattern: /\bchmod\b/,
        category: 'system_modification',
        riskScore: 25,
        description: '修改文件权限',
    },

    // ═══ 其他危险模式 ═══
    {
        pattern: /:\s*\(\)\s*{\s*:\s*\|\s*:\s*&\s*}\s*;\s*:/,
        category: 'system_modification',
        riskScore: 100,
        description: 'Fork 炸弹',
    },
    {
        pattern: /\bnpm\s+unpublish\b/,
        category: 'file_destruction',
        riskScore: 90,
        description: '从 npm 注销包（不可逆）',
    },
    {
        pattern: /\bnpm\s+publish\b/,
        category: 'file_destruction',
        riskScore: 65,
        description: '发布 npm 包',
    },
    {
        pattern: /\bwget\b.*-O\s+\//,
        category: 'file_destruction',
        riskScore: 85,
        description: '下载文件覆盖系统路径',
    },
];

// ─── 内置白名单 ──────────────────────────────────────────

interface WhitelistEntry {
    pattern: string;
    description: string;
}

/**
 * 内置白名单：即使命中危险规则也放行的常见无害操作。
 * 匹配使用精确字符串包含比较。
 */
const BUILTIN_WHITELIST: WhitelistEntry[] = [
    { pattern: 'rm -rf node_modules', description: '标准 node_modules 清理' },
    { pattern: 'rm -rf dist', description: '构建产物清理' },
    { pattern: 'rm -rf .next', description: 'Next.js 构建缓存清理' },
    { pattern: 'rm -rf build', description: '构建产物清理' },
    { pattern: 'rm -rf coverage', description: '测试覆盖率报告清理' },
    { pattern: 'rm -rf .turbo', description: 'Turborepo 缓存清理' },
    { pattern: 'rm -rf .cache', description: '缓存目录清理' },
    { pattern: 'rm -rf *.log', description: '日志文件清理' },
    { pattern: 'rm -rf tmp', description: '临时目录清理' },
    { pattern: 'rm -rf temp', description: '临时目录清理' },
    { pattern: 'rm -rf __pycache__', description: 'Python 缓存清理' },
    { pattern: 'rm -rf *.pyc', description: 'Python 编译文件清理' },
    { pattern: 'rm -rf .pytest_cache', description: 'Pytest 缓存清理' },
    { pattern: 'rm -rf target', description: 'Rust/Java 构建产物清理' },
    { pattern: 'rm -rf *.tsbuildinfo', description: 'TypeScript 构建信息清理' },
    { pattern: 'rm -rf .swc', description: 'SWC 缓存清理' },
    { pattern: 'git status', description: '只读 Git 状态查询' },
    { pattern: 'git log', description: '只读 Git 日志查看' },
    { pattern: 'git diff', description: '只读 Git 差异查看' },
    { pattern: 'git branch', description: '只读 Git 分支列表' },
];

// ─── 辅助函数 ────────────────────────────────────────────

/**
 * 对命令文本做简单规范化，便于白名单匹配。
 * - 合并多余空白
 * - 去掉首尾空白
 */
function normalizeCommand(command: string): string {
    return command.trim().replace(/\s+/g, ' ');
}

/**
 * 检查命令是否命中白名单。
 * 使用精确包含匹配（命令中包含白名单模式即放行）。
 */
export function isWhitelisted(command: string): boolean {
    const normalized = normalizeCommand(command);
    for (const entry of BUILTIN_WHITELIST) {
        if (normalized.includes(entry.pattern)) {
            return true;
        }
    }
    return false;
}

/**
 * 对给定的 bash 命令进行风险评估。
 *
 * 算法：
 * 1. 先检查白名单 → 命中则直接返回 safe
 * 2. 遍历所有危险规则
 * 3. 取最高风险分数（不是累加）
 * 4. 映射到风险等级
 */
export function assessRisk(command: string): DangerAssessment {
    // 白名单优先
    if (isWhitelisted(command)) {
        return {
            level: 'safe',
            score: 0,
            matchedRules: [],
            description: null,
            category: null,
        };
    }

    const matches: DangerRule[] = [];

    for (const rule of DANGER_RULES) {
        if (rule.pattern.test(command)) {
            matches.push(rule);
        }
    }

    if (matches.length === 0) {
        return {
            level: 'safe',
            score: 0,
            matchedRules: [],
            description: null,
            category: null,
        };
    }

    // 取最高分规则（不是累加，避免"多个低危 = 高危"的伪阳性）
    const topRule = matches.reduce((a, b) => (a.riskScore > b.riskScore ? a : b));

    const level: DangerAssessment['level'] =
        topRule.riskScore >= CRITICAL_THRESHOLD
            ? 'critical'
            : topRule.riskScore >= DANGEROUS_THRESHOLD
              ? 'dangerous'
              : topRule.riskScore >= WARNING_THRESHOLD
                ? 'warning'
                : 'safe';

    return {
        level,
        score: topRule.riskScore,
        matchedRules: matches,
        description: topRule.description,
        category: topRule.category,
    };
}

/**
 * 按分类名称返回人类可读的中文标签。
 */
export function getCategoryLabel(category: DangerCategory): string {
    const labels: Record<DangerCategory, string> = {
        file_destruction: '文件/数据销毁',
        system_modification: '系统修改',
        network_danger: '网络操作',
        git_destructive: 'Git 破坏性操作',
        privilege_escalation: '权限提升',
        rce: '代码执行 / 供应链攻击',
    };
    return labels[category];
}

/**
 * 按风险等级返回对应的颜色标识（用于终端 UI）。
 */
export function getLevelColor(level: DangerAssessment['level']): string {
    switch (level) {
        case 'critical':
            return 'red';
        case 'dangerous':
            return 'yellow';
        case 'warning':
            return 'yellow';
        case 'safe':
            return 'green';
    }
}

/**
 * 按风险等级返回对应的图标。
 */
export function getLevelIcon(level: DangerAssessment['level']): string {
    switch (level) {
        case 'critical':
            return '🛑';
        case 'dangerous':
            return '⚠';
        case 'warning':
            return '⚡';
        case 'safe':
            return '✓';
    }
}
