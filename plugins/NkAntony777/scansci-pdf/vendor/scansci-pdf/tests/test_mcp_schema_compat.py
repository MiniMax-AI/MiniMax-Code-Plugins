"""Keep the delivered MCP smoke check compatible with supported SDK schemas."""

import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest
from mcp.types import Tool


SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'check_mcp_package.py'
SPEC = importlib.util.spec_from_file_location('check_mcp_package', SCRIPT)
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)
SCHEMA = {'type': 'object', 'properties': {'confirmed': {'type': 'boolean'}}}


def test_installed_sdk_tool_schema():
    tool = Tool(name='scansci_pdf_schools', inputSchema=SCHEMA)
    assert CHECK.tool_input_schema(tool) == SCHEMA


@pytest.mark.parametrize('attribute', ['input_schema', 'inputSchema'])
def test_current_and_legacy_schema_attributes(attribute):
    tool = SimpleNamespace(**{attribute: SCHEMA})
    assert CHECK.tool_input_schema(tool) is SCHEMA


def test_current_schema_does_not_access_legacy_attribute():
    class CurrentTool:
        input_schema = SCHEMA

        @property
        def inputSchema(self):
            raise AssertionError('legacy attribute must not be accessed')

    assert CHECK.tool_input_schema(CurrentTool()) is SCHEMA


def test_missing_current_schema_falls_back_to_legacy():
    tool = SimpleNamespace(input_schema=None, inputSchema=SCHEMA)
    assert CHECK.tool_input_schema(tool) is SCHEMA


@pytest.mark.parametrize('tool', [
    SimpleNamespace(),
    SimpleNamespace(input_schema=None),
    SimpleNamespace(input_schema='not a schema', inputSchema=SCHEMA),
    SimpleNamespace(inputSchema=[]),
])
def test_missing_or_malformed_schema_is_rejected(tool):
    with pytest.raises(AssertionError, match='no valid input schema'):
        CHECK.tool_input_schema(tool)
