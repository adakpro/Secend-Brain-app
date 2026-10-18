export function nativeCommands(mode) {
  if (mode === 'claude') return { login: ['auth', 'login'], status: ['auth', 'status'], logout: ['auth', 'logout'], shell: [] };
  if (mode !== 'codex') throw new Error('invalid native CLI mode');
  const policy = ['--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=false', '-c', 'web_search="disabled"'];
  return {
    login: ['login', '--device-auth'], status: ['login', 'status'], logout: ['logout'],
    shell: ['--ask-for-approval', 'on-request', ...policy],
    exec: ['exec', '--ephemeral', '--json', '--skip-git-repo-check', ...policy],
  };
}

export function codexEvent(m) {
  if (m.type === 'item.completed' && m.item?.type === 'agent_message') {
    return { event: { type: 'text', text: String(m.item.text ?? '').slice(0, 4000) }, result: { subtype: 'success', isError: false, text: String(m.item.text ?? '').slice(0, 20000), numTurns: null } };
  }
  if (m.type === 'item.completed' && ['command_execution', 'file_change', 'mcp_tool_call'].includes(m.item?.type)) {
    return { event: { type: 'tool', name: m.item.type, summary: String(m.item.command ?? m.item.tool ?? 'staging').slice(0, 200) } };
  }
  if (m.type === 'error' || m.type === 'turn.failed') return { error: 'Codex execution failed', result: { subtype: 'error', isError: true, text: 'Codex execution failed', numTurns: null } };
  return {};
}
