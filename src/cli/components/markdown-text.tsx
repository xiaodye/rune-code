import React from 'react';
import { Box, Text } from 'ink';
import { marked, Token, Tokens } from 'marked';

interface MarkdownTextProps {
    content: string;
    trailing?: React.ReactNode;
}

/** 递归渲染行内 token，直接嵌套 Ink Text，简单直接 */
function renderInline(tokens: Token[] | undefined, keyPrefix: string): React.ReactNode[] {
    if (!tokens) return [];
    return tokens.map((token, i) => {
        const key = `${keyPrefix}-${i}`;

        switch (token.type) {
            case 'text':
                return token.text;

            case 'strong':
                return (
                    <Text key={key} bold>
                        {renderInline(token.tokens, key)}
                    </Text>
                );

            case 'em':
                return (
                    <Text key={key} dimColor>
                        {renderInline(token.tokens, key)}
                    </Text>
                );

            case 'del':
                return (
                    <Text key={key} dimColor strikethrough>
                        {renderInline(token.tokens, key)}
                    </Text>
                );

            case 'codespan':
                return (
                    <Text key={key} color="cyan">
                        {token.text}
                    </Text>
                );

            case 'link': {
                const linkToken = token as Tokens.Link;
                return (
                    <Text key={key}>
                        <Text underline color="blue">
                            {renderInline(linkToken.tokens, key)}
                        </Text>
                        <Text dimColor> ({linkToken.href})</Text>
                    </Text>
                );
            }

            case 'image': {
                const imgToken = token as Tokens.Image;
                return (
                    <Text key={key} dimColor>
                        [Image: {imgToken.text || imgToken.href}]
                    </Text>
                );
            }

            case 'br':
                return '\n';

            case 'escape':
                return (
                    <Text key={key} dimColor>
                        {token.text}
                    </Text>
                );

            default:
                if ('text' in token && typeof token.text === 'string') {
                    return token.text;
                }
                return null;
        }
    });
}

const HEADING_COLORS: Record<number, string> = {
    1: '#FFD700',
    2: '#00CED1',
    3: '#7FFFD4',
    4: '#DDA0DD',
    5: '#F0E68C',
    6: '#B0C4DE',
};

function renderBlock(token: Token, key: number): React.ReactNode {
    switch (token.type) {
        case 'heading': {
            const h = token as Tokens.Heading;
            const color = HEADING_COLORS[h.depth] || 'white';
            const prefix = h.depth === 1 ? '━ '.repeat(3) : '';
            return (
                <Box key={key} marginTop={1}>
                    <Text bold color={color}>
                        {prefix}
                        {renderInline(h.tokens, `h-${key}`)}
                    </Text>
                </Box>
            );
        }

        case 'paragraph': {
            const p = token as Tokens.Paragraph;
            return (
                <Box key={key} marginTop={1}>
                    <Text wrap="wrap">
                        {renderInline(p.tokens, `p-${key}`)}
                    </Text>
                </Box>
            );
        }

        case 'code': {
            const code = token as Tokens.Code;
            const codeText = code.text.replace(/\n$/, '');
            return (
                <Box
                    key={key}
                    flexDirection="column"
                    borderStyle="round"
                    borderColor="gray"
                    paddingX={1}
                    marginTop={1}
                >
                    {code.lang ? <Text dimColor>{code.lang}</Text> : null}
                    <Text color="green">{codeText}</Text>
                </Box>
            );
        }

        case 'blockquote': {
            const bq = token as Tokens.Blockquote;
            return (
                <Box key={key} flexDirection="row" marginTop={1}>
                    <Box width={2} flexShrink={0}>
                        <Text color="gray" dimColor>│</Text>
                    </Box>
                    <Box flexDirection="column" flexGrow={1}>
                        {bq.tokens.map((t, i) => renderBlock(t, i))}
                    </Box>
                </Box>
            );
        }

        case 'list': {
            const list = token as Tokens.List;
            return (
                <Box key={key} flexDirection="column" marginTop={1}>
                    {list.items.map((item, idx) => {
                        const bullet = list.ordered
                            ? `${list.start !== '' ? Number(list.start) + idx : idx + 1}. `
                            : '• ';
                        return (
                            <Box key={idx} flexDirection="row">
                                <Box width={3} flexShrink={0}>
                                    <Text>{bullet}</Text>
                                </Box>
                                <Box flexDirection="column" flexGrow={1}>
                                    {item.tokens.map((child, ci) => renderBlock(child, ci))}
                                </Box>
                            </Box>
                        );
                    })}
                </Box>
            );
        }

        case 'hr':
            return (
                <Box key={key} marginTop={1}>
                    <Text color="gray" dimColor>
                        ─────────────────────────────
                    </Text>
                </Box>
            );

        case 'space':
            return null;

        case 'html': {
            const html = token as Tokens.HTML;
            return (
                <Box key={key}>
                    <Text dimColor>{html.text}</Text>
                </Box>
            );
        }

        case 'table': {
            const table = token as Tokens.Table;
            const allRows = [table.header, ...table.rows];
            const colCount = table.header.length;
            const colWidths: number[] = Array.from({ length: colCount }, () => 0);
            for (const row of allRows) {
                for (let i = 0; i < colCount; i++) {
                    colWidths[i] = Math.max(colWidths[i], (row[i]?.text ?? '').length);
                }
            }
            const padded = colWidths.map((w) => w + 2);

            return (
                <Box key={key} flexDirection="column" marginTop={1}>
                    <Box flexDirection="row">
                        {table.header.map((cell, ci) => (
                            <Box key={ci} width={padded[ci]}>
                                <Text bold>
                                    {renderInline(cell.tokens, `th-${key}-${ci}`)}
                                </Text>
                            </Box>
                        ))}
                    </Box>
                    <Box flexDirection="row">
                        {table.header.map((_, ci) => (
                            <Box key={ci} width={padded[ci]}>
                                <Text color="gray" dimColor>
                                    {'─'.repeat(padded[ci])}
                                </Text>
                            </Box>
                        ))}
                    </Box>
                    {table.rows.map((row, ri) => (
                        <Box key={ri} flexDirection="row">
                            {row.map((cell, ci) => (
                                <Box key={ci} width={padded[ci]}>
                                    <Text>
                                        {renderInline(cell.tokens, `td-${key}-${ri}-${ci}`)}
                                    </Text>
                                </Box>
                            ))}
                        </Box>
                    ))}
                </Box>
            );
        }

        default:
            if ('text' in token && typeof token.text === 'string' && token.text.trim()) {
                return (
                    <Box key={key} marginTop={1}>
                        <Text>{token.text}</Text>
                    </Box>
                );
            }
            return null;
    }
}

/**
 * 终端 Markdown 渲染器。
 * 基于 marked 词法分析，将 token 树映射为 Ink Text/Box 组件。
 */
export const MarkdownText: React.FC<MarkdownTextProps> = ({ content, trailing }) => {
    if (!content?.trim()) {
        return trailing ? <Text>{trailing}</Text> : null;
    }

    let tokens: Token[];
    try {
        tokens = marked.lexer(content);
    } catch {
        return (
            <Box marginTop={1}>
                <Text wrap="wrap">{content}</Text>
            </Box>
        );
    }

    return (
        <Box flexDirection="column">
            {tokens.map((token, i) => renderBlock(token, i))}
            {trailing}
        </Box>
    );
};
