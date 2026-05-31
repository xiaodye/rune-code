import React from 'react';
import { Box, Text } from 'ink';
import { marked, Token, Tokens } from 'marked';

interface MarkdownTextProps {
    content: string;
}

/** A flat, unstyled text segment — Ink renders each as a separate <Text> to avoid nesting bugs */
interface FlatSegment {
    text: string;
    bold?: boolean;
    dim?: boolean;
    color?: string;
    underline?: boolean;
    strikethrough?: boolean;
}

/** Recursively flatten inline tokens into a non-nested array of styled segments */
function flattenInline(tokens: Token[] | undefined): FlatSegment[] {
    if (!tokens) return [];
    const result: FlatSegment[] = [];

    for (const token of tokens) {
        switch (token.type) {
            case 'text':
                result.push({ text: token.text });
                break;

            case 'strong': {
                const inner = flattenInline(token.tokens);
                for (const seg of inner) {
                    result.push({ ...seg, bold: true });
                }
                break;
            }

            case 'em': {
                const inner = flattenInline(token.tokens);
                for (const seg of inner) {
                    result.push({ ...seg, dim: true });
                }
                break;
            }

            case 'del': {
                const inner = flattenInline(token.tokens);
                for (const seg of inner) {
                    result.push({ ...seg, dim: true, strikethrough: true });
                }
                break;
            }

            case 'codespan':
                result.push({ text: token.text, color: 'cyan' });
                break;

            case 'link': {
                const linkToken = token as Tokens.Link;
                const inner = flattenInline(linkToken.tokens);
                for (const seg of inner) {
                    result.push({ ...seg, underline: true, color: seg.color || 'blue' });
                }
                result.push({ text: ` (${linkToken.href})`, dim: true });
                break;
            }

            case 'image': {
                const imgToken = token as Tokens.Image;
                result.push({ text: `[Image: ${imgToken.text || imgToken.href}]`, dim: true });
                break;
            }

            case 'br':
                result.push({ text: '\n' });
                break;

            case 'escape':
                result.push({ text: token.text, dim: true });
                break;

            default:
                if ('text' in token && typeof token.text === 'string') {
                    result.push({ text: token.text });
                }
        }
    }

    return result;
}

/** Render flat segments as separate <Text> elements inside a flex-wrap Box */
function renderSegments(
    segments: FlatSegment[],
    keyPrefix: string,
    extraTextProps: { color?: string; bold?: boolean } = {},
): React.ReactNode {
    if (segments.length === 0) return null;

    return (
        <Box key={keyPrefix} flexDirection="row" flexWrap="wrap">
            {segments.map((seg, i) => {
                // Skip empty segments (but keep spaces)
                if (!seg.text) return null;

                return (
                    <Text
                        key={`${keyPrefix}-s-${i}`}
                        bold={seg.bold ?? extraTextProps.bold}
                        dimColor={seg.dim}
                        color={seg.color ?? extraTextProps.color}
                        underline={seg.underline}
                        strikethrough={seg.strikethrough}
                    >
                        {seg.text}
                    </Text>
                );
            })}
        </Box>
    );
}

/** Heading colors by depth */
const HEADING_COLORS: Record<number, string> = {
    1: '#FFD700',
    2: '#00CED1',
    3: '#7FFFD4',
    4: '#DDA0DD',
    5: '#F0E68C',
    6: '#B0C4DE',
};

/** Render a single block-level token */
function renderBlock(token: Token, key: number): React.ReactNode {
    switch (token.type) {
        case 'heading': {
            const h = token as Tokens.Heading;
            const color = HEADING_COLORS[h.depth] || 'white';
            const prefix = h.depth === 1 ? '━ '.repeat(3) : '';
            const segments = flattenInline(h.tokens);
            // Prepend the h1 decoration as a segment
            const allSegments: FlatSegment[] = prefix
                ? [{ text: prefix, bold: true, color }, ...segments]
                : segments;

            return (
                <Box key={key} marginTop={1}>
                    {renderSegments(allSegments, `h-${key}`, { bold: true, color })}
                </Box>
            );
        }

        case 'paragraph': {
            const p = token as Tokens.Paragraph;
            const segments = flattenInline(p.tokens);
            return (
                <Box key={key} marginTop={1}>
                    {renderSegments(segments, `p-${key}`)}
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
                        <Text color="gray" dimColor>
                            │
                        </Text>
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
                    const cellText = row[i]?.text ?? '';
                    colWidths[i] = Math.max(colWidths[i], cellText.length);
                }
            }
            const padded = colWidths.map((w) => w + 2);

            return (
                <Box key={key} flexDirection="column" marginTop={1}>
                    {/* Header */}
                    <Box flexDirection="row">
                        {table.header.map((cell, ci) => (
                            <Box key={ci} width={padded[ci]}>
                                {renderSegments(flattenInline(cell.tokens), `th-${key}-${ci}`, {
                                    bold: true,
                                })}
                            </Box>
                        ))}
                    </Box>
                    {/* Separator */}
                    <Box flexDirection="row">
                        {table.header.map((_, ci) => (
                            <Box key={ci} width={padded[ci]}>
                                <Text color="gray" dimColor>
                                    {'─'.repeat(padded[ci])}
                                </Text>
                            </Box>
                        ))}
                    </Box>
                    {/* Rows */}
                    {table.rows.map((row, ri) => (
                        <Box key={ri} flexDirection="row">
                            {row.map((cell, ci) => (
                                <Box key={ci} width={padded[ci]}>
                                    {renderSegments(
                                        flattenInline(cell.tokens),
                                        `td-${key}-${ri}-${ci}`,
                                    )}
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
 * Terminal-aware markdown renderer using Ink components.
 *
 * Uses a flat-segment architecture: inline tokens are recursively flattened
 * into a non-nested array of { text, bold?, dim?, color?, ... } descriptors,
 * then rendered as sibling <Text> elements inside a <Box flexWrap="wrap">.
 * This avoids Ink's known issue where wrapping <Text> with nested <Text bold>
 * children can silently drop styling.
 */
export const MarkdownText: React.FC<MarkdownTextProps> = ({ content }) => {
    if (!content?.trim()) {
        return null;
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
        </Box>
    );
};
