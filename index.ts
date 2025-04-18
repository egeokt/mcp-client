// anthropic sdk

import { Anthropic } from '@anthropic-ai/sdk';
import { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages/messages.mjs';

// mcp 
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import dotenv from 'dotenv';

import readline from 'readline/promises';

dotenv.config();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
    throw new Error('No api key provided.');
}

class MCPClient {
    private mcp: Client;
    private llm: Anthropic;
    private transport: StdioClientTransport | null = null;
    private tools: Tool[] = [];

    constructor() {
        this.llm = new Anthropic({
            apiKey: ANTHROPIC_API_KEY,
        });
        this.mcp = new Client({ name: 'mcp-client-cli', version: '1.0.0'});
    }

    // connect to the mcp
    async connectToServer(serverScriptPath: string) {
        const isJs = serverScriptPath.endsWith('.js');
        const isPy = serverScriptPath.endsWith('.py');

        if (!isJs && !isPy) {
            throw new Error('Server script must be a .js or .py file');
        }

        const command = isPy ? process.platform === 'win32'
                ? 'python'
                : 'python3'
            : process.execPath;

        this.transport = new StdioClientTransport({
            command,
            args: [serverScriptPath],
        });

        await this.mcp.connect(this.transport);


        // register tools
        const toolsResult = await this.mcp.listTools();
        this.tools = toolsResult.tools.map((tool) => {
            return {
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema
            };
        });

        console.log('=== Connected to server with tools:',
            this.tools.map(({name}) => name)
        );
    }

    async processQuery(query:string) {
        // call the llm
        const messages: MessageParam[] = [
            {
                role: 'user',
                content: query,
            }
        ];

        const response = await this.llm.messages.create({
            model: 'claude-3-5-sonnet-latest',
            max_tokens: 1000,
            messages,
            tools: this.tools,
        });

        console.log('\n == Received llm response', response, '/n');


        // check the response
        const finalText = [];
        const toolResults = [];

        // if text -> return response
        for (const content of response.content) {
            if (content.type === 'text') {
                // do some
            } else if (content.type === 'tool_use') {
                // gotta call the tool on mcp server
                const toolName = content.name;
                const toolArgs = content.input as { [x: string]: unknown } | undefined;

                const result = await this.mcp.callTool({
                    name: toolName,
                    arguments: toolArgs,
                });

                toolResults.push(result);
                finalText.push(
                    `[Calling tool ${toolName} with args ${JSON.stringify(toolArgs)}]`
                );

                messages.push({
                    role: 'user',
                    content: result.content as string,
                });

                const response = await this.llm.messages.create({
                    model: 'claude-3-5-sonnet-latest',
                    max_tokens: 1000,
                    messages,
                });


                console.log('\n == Received llm response', response, '/n');

                finalText.push(
                    response.content[0].type === 'text' ? response.content[0].text : ''
                );
            }
        }

        return finalText.join('\n');
    }

    async chatLoop() {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });


        try {
            console.log('\n MCP Client Started!');
            console.log('Type your queries or quit to exit.');

            while(true) {
                const message = await rl.question('\nQuery: ');
                if (message.toLowerCase() === 'quit') {
                    break;
                }

                const response = await this.processQuery(message);
                console.log('\n' + response);
            }
        } catch (error) {
            console.log('=== error caught on chat loop', error);
        } finally {
            rl.close();
        }
    }

    async cleanup() {
        await this.mcp.close();
    }
}

async function main () {
    if (process.argv.length < 3) {
        console.log('Usage: node index.ts <path_to_server_script>');
        return;
    }

    const mcpClient = new MCPClient();

    try {
        await mcpClient.connectToServer(process.argv[2]);
        await mcpClient.chatLoop();
    } finally {
        await mcpClient.cleanup();
        process.exit(0);
    }
}

main();
