import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getTerminal } from './bash';

const ALLOWED_COMMANDS: RegExp[] = [
    /^\s*git\s+(diff|log|show|status|branch|rev-parse)/,
    /^\s*npm\s+(test|run\s+test|run\s+lint|run\s+typecheck)/,
    /^\s*npx\s+tsc(\s+--noEmit)?/,
    /^\s*npx\s+(jest|vitest|mocha|eslint)/,
    /^\s*cat\s/,
    /^\s*head\s/,
    /^\s*tail\s/,
    /^\s*wc\s/,
    /^\s*diff\s/,
    /^\s*echo\s/,
];

function isCommandAllowed(command: string): boolean {
    return ALLOWED_COMMANDS.some((pattern) => pattern.test(command.trim()));
}

export const bashReadonlyTool = tool(
    async ({ command }) => {
        if (!isCommandAllowed(command)) {
            return `Command not allowed in readonly mode: ${command}\n\nAllowed commands: git (diff/log/show/status/branch), npm test/lint, npx tsc/jest/vitest, cat, head, tail, wc, diff, echo`;
        }

        const terminal = getTerminal();
        const output = await terminal.execute(command);
        return `\`\`\`\n${output}\n\`\`\``;
    },
    {
        name: 'bash_readonly',
        description: `Execute read-only bash commands for code review purposes.

Allowed commands:
- git diff/log/show/status/branch
- npm test/run test/run lint
- npx tsc --noEmit / jest / vitest / eslint
- cat / head / tail / wc / diff / echo

All other commands will be rejected.`,
        schema: z.object({
            command: z.string().describe('The read-only command to execute.'),
        }),
    },
);
