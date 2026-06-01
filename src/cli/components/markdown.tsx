import React from 'react';
import { Text } from 'ink';
import { marked } from 'marked';
import TerminalRenderer from 'marked-terminal';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createRenderer = (): any => new TerminalRenderer();

interface MarkdownTextProps {
    content: string;
    trailing?: React.ReactNode;
}

/**
 * 终端 Markdown 渲染器。
 * 使用 marked-terminal 将 Markdown 转为 ANSI 终端文本。
 */
export const Markdown: React.FC<MarkdownTextProps> = ({ content, trailing }) => {
    if (!content?.trim()) {
        return trailing ? <Text>{trailing}</Text> : null;
    }

    let rendered: string;
    try {
        rendered = String(marked.parse(content, { renderer: createRenderer() })).trim();
    } catch {
        return (
            <Text wrap="wrap">
                {content}
                {trailing}
            </Text>
        );
    }

    return (
        <Text>
            {rendered}
            {trailing}
        </Text>
    );
};
