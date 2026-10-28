"""Real Pi + tmux UI regression. No network, clipboard, user config or saved sessions.
PI_HOST_DIR=/path/to/pi-coding-agent python3 test/native-ui.py
Requires tmux, vi, node (macOS/Linux). Creates and removes its own tmux session.
"""
import os, pathlib, shlex, shutil, subprocess, tempfile, time, uuid
host = os.environ.get('PI_HOST_DIR')
if not host: raise RuntimeError('Set PI_HOST_DIR')
tmux_bin = shutil.which('tmux'); node = shutil.which('node'); vi = shutil.which('vi')
assert tmux_bin and node and vi, 'tmux, node and vi are required'
name = 'picc-ui-' + uuid.uuid4().hex[:8]
def tmux(*args): return subprocess.check_output([tmux_bin, *args], text=True)
def screen(): return tmux('capture-pane', '-p', '-t', name)
def keys(*args): tmux('send-keys', '-t', name, *args)
def until(check, label, seconds=15):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        text = screen()
        if check(text): return text
        time.sleep(.05)
    raise AssertionError(label + '\n' + screen())
with tempfile.TemporaryDirectory(prefix='picc-ui-') as directory:
    d = pathlib.Path(directory); (d/'agent').mkdir(); (d/'work').mkdir()
    fixture = pathlib.Path(__file__).resolve().parent / 'fixtures/review-ui.ts'
    env = { 'PI_CODING_AGENT_DIR': str(d/'agent'), 'PICC_PERMISSION_MODES_CONFIG_PATH': str(d/'config.json'), 'CLAUDE_CONFIG_DIR': str(d/'claude'), 'EDITOR': vi, 'VISUAL': vi }
    command = ['env', '-u', 'HERDR_ENV', '-u', 'HERDR_PANE_ID', '-u', 'HERDR_SOCKET_PATH', '-u', 'HERDR_WORKSPACE_ID', '-u', 'HERDR_TAB_ID', *[k+'='+v for k,v in env.items()], node, str(pathlib.Path(host)/'dist/bundle/cli.js'), '--offline', '--no-session', '--no-extensions', '-e', str(fixture), '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-mcp']
    try:
        tmux('new-session', '-d', '-s', name, '-x', '130', '-y', '42', '-c', str(d/'work'), shlex.join(command))
        until(lambda s: 'review-ui.ts' in s, 'Pi did not load fixture')
        def open_review():
            keys('C-u', '/plan-repro', 'Enter'); until(lambda s: 'Ready to code?' in s, 'approval did not open')
        open_review(); keys('4', 'Enter')
        until(lambda s: 'Refine plan — what should change?' in s, 'native feedback did not open')
        keys('C-g'); until(lambda s: 'prompt.md" 0L' in s or '[New]' in s, 'managed vi did not open')
        keys('Escape', ':q!', 'Enter')
        until(lambda s: 'Refine plan — what should change?' in s, 'Pi did not restore feedback after vi')
        keys('Escape')
        until(lambda s: 'refine-cancelled' in s and 'Ready to code?' not in s, 'main input not restored')
        open_review(); keys('C-g')
        until(lambda s: 'Edit plan' in s and '# Original plan' in s, 'native plan edit did not open')
        keys('C-a', 'C-k', '# Edited plan', 'Enter')
        until(lambda s: 'Ready to code?' in s and 'Edited plan' in s, 'saved edit did not reopen approval')
        keys('Escape'); until(lambda s: '"stay"' in s and 'Ready to code?' not in s, 'main input not usable')
        print('PASS native feedback / managed vi / cancel / usable input / edit-save-reapproval')
    finally:
        subprocess.run([tmux_bin, 'kill-session', '-t', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
