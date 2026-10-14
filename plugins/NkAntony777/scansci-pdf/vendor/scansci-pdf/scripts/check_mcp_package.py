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


def tool_payload(response):
    value = json.loads(response.content[0].text)
    return value['result'] if value.get('trust') == 'untrusted_external_data' else value


def tool_input_schema(tool):
    # MCP 2.x uses snake_case attributes; MCP 1.x uses the wire alias.
    schema = getattr(tool, 'input_schema', None)
    if schema is None:
        schema = getattr(tool, 'inputSchema', None)
    if not isinstance(schema, dict):
        raise AssertionError('MCP tool has no valid input schema')
    return schema


async def main():
    entry = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='scansci-mcp-') as folder:
        workspace = Path(folder)
        (workspace/'reading.txt').write_text('10.1038/s41586-024-07386-0\n', encoding='utf-8')
        package = entry.parents[2]
        server = json.loads((package / 'mcp.json').read_text(encoding='utf-8'))['mcpServers']['scansci-pdf']
        arguments = [value.replace('${PLUGIN_ROOT}', str(package)) for value in server['args']]
        parameters = StdioServerParameters(command=server['command'], args=arguments, cwd=folder,
            env={**server.get('env', {}), 'SCANSCI_PDF_PYTHON': sys.executable,
                 'SCANSCI_PROGRESS_BAR': '0', 'PYTHONPATH': folder, 'PYTHONHOME': str(workspace/'poison')})
        async with stdio_client(parameters) as (read, write):
            async with ClientSession(read, write) as client:
                await client.initialize()
                tools = await client.list_tools()
                names = {tool.name for tool in tools.tools}
                assert 'scansci_pdf_parse_list' in names and 'scansci_pdf_tor' in names
                school_tool = next(tool for tool in tools.tools if tool.name == 'scansci_pdf_schools')
                assert tool_input_schema(school_tool)['properties']['confirmed']['type'] == 'boolean'
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
                config_file = workspace/'.scansci-pdf'/'config.json'
                assert config_file.exists()
                before = config_file.read_bytes()
                database = json.loads((entry.parent/'src'/'scansci_pdf'/'data'/'webvpn.json').read_text(encoding='utf-8'))
                school, info = next((name, info) for schools in database.values()
                                    for name, info in schools.items()
                                    if info.get('host') and info.get('type', 'webvpn') == 'webvpn')
                for key in ('vpnsci_school', 'instsci_school'):
                    refused = await client.call_tool('scansci_pdf_config', {'key': key, 'value': school})
                    assert tool_payload(refused)['success'] is False
                    assert config_file.read_bytes() == before
                for confirmation in (False, 1, 'true'):
                    refused = await client.call_tool('scansci_pdf_schools',
                        {'action': 'set', 'school': school, 'confirmed': confirmation})
                    if not getattr(refused, 'is_error', getattr(refused, 'isError', False)):
                        assert tool_payload(refused)['success'] is False
                    assert config_file.read_bytes() == before
                accepted = await client.call_tool('scansci_pdf_schools',
                    {'action': 'set', 'school': school, 'confirmed': True})
                assert not getattr(accepted, 'is_error', getattr(accepted, 'isError', False)), accepted
                assert tool_payload(accepted)['success'] is True
                stored = json.loads(config_file.read_text(encoding='utf-8'))
                host = info['host'] if info['host'].startswith('http') else 'https://' + info['host']
                assert (stored['vpnsci_school'], stored['vpnsci_base_url'], stored['vpnsci_enabled']) == (school, host, True)
                before = config_file.read_bytes()
                unchanged = await client.call_tool('scansci_pdf_schools', {'action': 'set', 'school': school})
                assert tool_payload(unchanged)['success'] is True
                assert config_file.read_bytes() == before
                print(json.dumps({'tools': len(names), 'parse': 'passed', 'path_escape': 'blocked',
                    'tor_confirmation': 'required', 'secret_mask': 'passed',
                    'school_confirmation': 'required', 'school_setup': 'atomic', 'stdio': 'passed'}))
        result = subprocess.run([sys.executable, "-I", str(entry), '--helper', 'sort_finalize_writeback.py',
                                 'reading.txt', '--xlsx', 'original.xlsx'], cwd=folder, capture_output=True, text=True)
        assert result.returncode != 0 and '--confirm-writeback' in result.stderr
        clean = subprocess.run([sys.executable, "-I", str(entry), '--verify'], cwd=folder, capture_output=True, text=True)
        assert clean.returncode == 0, clean.stderr
        copied = workspace/'tampered-engine'
        shutil.copytree(entry.parent, copied, ignore=shutil.ignore_patterns('__pycache__', '*.pyc', '.venv', '.pytest_cache', '*.egg-info', 'uv.lock'))
        changed = copied/'src'/'scansci_pdf'/'security.py'
        changed.write_bytes(changed.read_bytes()+b'\n# tampered\n')
        tampered = subprocess.run([sys.executable, "-I", str(copied/'run_secure.py'), '--verify'], cwd=folder, capture_output=True, text=True)
        assert tampered.returncode != 0 and 'Pinned engine source changed' in tampered.stderr
        print('source-integrity: tampering rejected')


if __name__ == '__main__':
    asyncio.run(main())
