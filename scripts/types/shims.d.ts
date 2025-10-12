declare module 'openai' {
  const OpenAI: any;
  export default OpenAI;
}

declare module '@modelcontextprotocol/sdk/client/index.js' {
  export const Client: any;
}
declare module '@modelcontextprotocol/sdk/client/stdio.js' {
  export const StdioClientTransport: any;
}
declare module '@modelcontextprotocol/sdk/types.js' {
  export type Tool = any;
}


