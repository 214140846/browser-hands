// 打包成单文件时的入口：node thundermcp.mjs mcp | setup [...] ；Chrome 拉起 native host 时第一个参数是插件 origin
const [cmd = '', ...rest] = process.argv.slice(2)

if (cmd === 'mcp') await import('./mcp')
else if (cmd === 'host' || cmd.startsWith('chrome-extension://')) await import('./host')
else if (cmd === 'setup') (await import('./install')).main(rest)
else {
  console.log('Usage: node thundermcp.mjs setup [--uninstall]   write / remove the Chrome native host manifest\n       node thundermcp.mjs mcp                 start the MCP server (for agent config)')
  process.exit(cmd ? 1 : 0)
}
