"""Exercise the actual stdio engine process in a disposable project workspace."""
import asyncio
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import shutil

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def main():
    entry = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='scansci-mcp-') as folder:
        workspace = Path(folder)
        (workspace/'reading.txt').write_text('10.1038/s41586-024-07386-0\n', encoding='utf-8')
        parameters = StdioServerParameters(command=sys.executable, args=[str(entry), 'run', '--mode', 'stdio'], cwd=folder)
        async with stdio_client(parameters) as (read, write):
            async with ClientSession(read, write) as client:
                await client.initialize()
                tools = await client.list_tools()
                names = {tool.name for tool in tools.tools}
                assert 'scansci_pdf_parse_list' in names and 'scansci_pdf_tor' in names
                parsed = await client.call_tool('scansci_pdf_parse_list', {'file_path': 'reading.txt'})
                assert not getattr(parsed, 'is_error', getattr(parsed, 'isError', False)), parsed
                payload = json.loads(parsed.content[0].text)
                assert payload['trust'] == 'untrusted_external_data'
                assert '10.1038/s41586-024-07386-0' in json.dumps(payload), payload
                escaped = await client.call_tool('scansci_pdf_parse_list', {'file_path': '../outside.txt'})
                assert getattr(escaped, 'is_error', getattr(escaped, 'isError', False))
                blocked = await client.call_tool('scansci_pdf_tor', {'action': 'install'})
                assert 'confirmation' in blocked.content[0].text.lower()
                config = await client.call_tool('scansci_pdf_config', {'key': 'springer_api_key', 'value': 'test-secret'})
                assert 'test-secret' not in config.content[0].text
                assert (workspace/'.scansci-pdf'/'config.json').exists()
                print(json.dumps({'tools': len(names), 'parse': 'passed', 'path_escape': 'blocked',
                    'tor_confirmation': 'required', 'secret_mask': 'passed', 'stdio': 'passed'}))
        result = subprocess.run([sys.executable, str(entry), '--helper', 'sort_finalize_writeback.py',
                                 'reading.txt', '--xlsx', 'original.xlsx'], cwd=folder, capture_output=True, text=True)
        assert result.returncode != 0 and '--confirm-writeback' in result.stderr
        clean = subprocess.run([sys.executable, str(entry), '--verify'], cwd=folder, capture_output=True, text=True)
        assert clean.returncode == 0, clean.stderr
        copied = workspace/'tampered-engine'
        shutil.copytree(entry.parent, copied, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        changed = copied/'src'/'scansci_pdf'/'security.py'
        changed.write_bytes(changed.read_bytes()+b'\n# tampered\n')
        tampered = subprocess.run([sys.executable, str(copied/'run_secure.py'), '--verify'], cwd=folder, capture_output=True, text=True)
        assert tampered.returncode != 0 and 'Pinned engine source changed' in tampered.stderr
        print('source-integrity: tampering rejected')


asyncio.run(main())
