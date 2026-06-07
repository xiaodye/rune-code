import type { StructuredToolInterface } from '@langchain/core/tools';

export type SubAgentType = 'explorer' | 'coder' | 'reviewer';

export interface SubAgentConfig {
    type: SubAgentType;
    tools: StructuredToolInterface[];
    systemPrompt: string;
    modelCallLimit: number;
}
