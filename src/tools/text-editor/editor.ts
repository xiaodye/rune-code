import fs from 'fs-extra';
import path from 'path';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

class TextEditor {
    validatePath(command: string, filePath: string) {
        if (!path.isAbsolute(filePath)) {
            const suggestedPath = path.resolve(filePath);
            throw new Error(
                `The path ${filePath} is not an absolute path, it should start with \`/\`. Do you mean ${suggestedPath}?`,
            );
        }
    }

    async view(filePath: string, viewRange?: [number, number]): Promise<string> {
        if (!(await fs.pathExists(filePath))) {
            throw new Error(`File does not exist: ${filePath}`);
        }
        const stats = await fs.stat(filePath);
        if (!stats.isFile()) {
            throw new Error(`Path is not a file: ${filePath}`);
        }

        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        let startLine = 1;
        let endLine = lines.length;

        if (viewRange) {
            if (viewRange.length !== 2 || !viewRange.every(Number.isInteger)) {
                throw new Error('Invalid `view_range`. It should be a list of two integers.');
            }
            [startLine, endLine] = viewRange;

            if (startLine < 1 || startLine > lines.length) {
                throw new Error(
                    `Invalid \`view_range\`: [${startLine}, ${endLine}]. The start line \`${startLine}\` should be within the range of lines in the file: [1, ${lines.length}]`,
                );
            }

            if (endLine === -1) {
                endLine = lines.length;
            } else if (endLine < startLine || endLine > lines.length) {
                // Python logic: if endLine > n_lines, cap it.
                if (endLine > lines.length) {
                    endLine = lines.length;
                } else {
                    throw new Error(
                        `Invalid \`view_range\`: [${startLine}, ${endLine}]. The end line \`${endLine}\` should be -1 or within the range of lines in the file: [${startLine}, ${lines.length}]`,
                    );
                }
            }
        }

        // 0-indexed slice
        const selectedLines = lines.slice(startLine - 1, endLine);

        // Add line numbers
        return selectedLines
            .map((line, index) => {
                const lineNum = startLine + index;
                return `${String(lineNum).padStart(3, ' ')} ${line}`;
            })
            .join('\n');
    }

    async strReplace(filePath: string, oldStr: string, newStr: string): Promise<number> {
        if (!(await fs.pathExists(filePath))) {
            throw new Error(`File does not exist: ${filePath}`);
        }
        if (!(await fs.stat(filePath)).isFile()) {
            throw new Error(`Path is not a file: ${filePath}`);
        }

        const content = await fs.readFile(filePath, 'utf-8');

        if (!content.includes(oldStr)) {
            throw new Error(`String not found in file: ${filePath}`);
        }

        const occurrences = content.split(oldStr).length - 1;
        const newContent = content.split(oldStr).join(newStr); // Replace all

        await this.writeFile(filePath, newContent);
        return occurrences;
    }

    async insert(filePath: string, insertLine: number, newStr: string): Promise<void> {
        if (!(await fs.pathExists(filePath))) {
            throw new Error(`File does not exist: ${filePath}`);
        }
        if (!(await fs.stat(filePath)).isFile()) {
            throw new Error(`Path is not a file: ${filePath}`);
        }

        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n');

        if (insertLine < 0) {
            throw new Error(`Invalid insert_line: ${insertLine}. Line number must be >= 0.`);
        }
        if (insertLine > lines.length) {
            throw new Error(
                `Invalid insert_line: ${insertLine}. Line number cannot be greater than the number of lines in the file (${lines.length}).`,
            );
        }

        if (insertLine === 0) {
            lines.unshift(newStr);
        } else {
            lines.splice(insertLine, 0, newStr);
        }

        await this.writeFile(filePath, lines.join('\n'));
    }

    async writeFile(filePath: string, content: string): Promise<void> {
        try {
            await fs.ensureDir(path.dirname(filePath));
            await fs.writeFile(filePath, content, 'utf-8');
        } catch (error: any) {
            throw new Error(`Error writing to ${filePath}: ${error.message}`);
        }
    }
}

export const textEditorTool = tool(
    async ({ command, path: filePath, file_text, view_range, old_str, new_str, insert_line }) => {
        const editor = new TextEditor();
        const _path = path.resolve(filePath);

        try {
            editor.validatePath(command, _path);

            if (command === 'view') {
                const content = await editor.view(
                    _path,
                    view_range as [number, number] | undefined,
                );
                return `Here's the result of running \`cat -n\` on ${_path}:\n\n\`\`\`\n${content}\n\`\`\``;
            } else if (command === 'str_replace') {
                if (old_str === undefined || new_str === undefined) {
                    return 'Error: old_str and new_str are required for str_replace command.';
                }
                const occurrences = await editor.strReplace(_path, old_str, new_str);
                return `Successfully replaced ${occurrences} occurrences in ${_path}.`;
            } else if (command === 'insert') {
                if (insert_line === undefined || new_str === undefined) {
                    return 'Error: insert_line and new_str are required for insert command.';
                }
                await editor.insert(_path, insert_line, new_str);
                return `Successfully inserted text at line ${insert_line} in ${_path}.`;
            } else if (command === 'create') {
                if ((await fs.pathExists(_path)) && (await fs.stat(_path)).isDirectory()) {
                    return `Error: the path ${_path} is a directory. Please provide a valid file path.`;
                }
                await editor.writeFile(_path, file_text || '');
                return `File successfully created at ${_path}.`;
            } else {
                return `Error: invalid command: ${command}`;
            }
        } catch (error: any) {
            return `Error: ${error.message}`;
        }
    },
    {
        name: 'text_editor',
        description: `A text editor tool supports view, create, str_replace, insert.

- \`view\` again when you fail to perform \`str_replace\` or \`insert\`.
- \`create\` can also be used to overwrite an existing file.
- \`str_replace\` can also be used to delete text in the file.`,
        schema: z.object({
            command: z
                .enum(['view', 'create', 'str_replace', 'insert'])
                .describe("One of 'view', 'create', 'str_replace', 'insert'."),
            path: z
                .string()
                .describe(
                    "The absolute path to the file. Only absolute paths are supported. Automatically create the directories if it doesn't exist.",
                ),
            file_text: z
                .string()
                .optional()
                .describe("Only applies for the 'create' command. The text to write to the file."),
            view_range: z
                .array(z.number())
                .optional()
                .describe(
                    "Only applies for the 'view' command. An array of two integers specifying the start and end line numbers to view. Line numbers are 1-indexed, and -1 for the end line means read to the end of the file.",
                ),
            old_str: z
                .string()
                .optional()
                .describe(
                    "Only applies for the 'str_replace' command. The text to replace (must match exactly, including whitespace and indentation).",
                ),
            new_str: z
                .string()
                .optional()
                .describe(
                    "Only applies for the 'str_replace' and 'insert' commands. The new text to insert in place of the old text.",
                ),
            insert_line: z
                .number()
                .optional()
                .describe(
                    "Only applies for the 'insert' command. The line number after which to insert the text (0 for beginning of file).",
                ),
        }),
    },
);
