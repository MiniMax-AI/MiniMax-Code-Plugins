import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

// Probe without site initialization; run only a supported absolute interpreter.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PYTHON/i.test(key)));
const selected = process.env.SCANSCI_PDF_PYTHON;
if (selected && !isAbsolute(selected)) {
  process.stderr.write('SCANSCI_PDF_PYTHON must name an absolute Python interpreter path.\n');
  process.exit(1);
}
const candidates = selected ? [selected] : ['python3', 'python'];
let executable;
for (const candidate of candidates) {
  const probe = spawnSync(candidate, ['-I', '-S', '-c',
    'import sys,json; print(json.dumps([sys.executable,list(sys.version_info[:2])]))'],
  { env, encoding: 'utf8', timeout: 10000, windowsHide: true, shell: false });
  if (probe.status !== 0) continue;
  try {
    const [path, version] = JSON.parse(probe.stdout);
    if (isAbsolute(path) && (version[0] > 3 || (version[0] === 3 && version[1] >= 11))) {
      executable = path;
      break;
    }
  } catch { /* A non-Python PATH entry is not a supported interpreter. */ }
}
if (!executable) {
  process.stderr.write('Python >=3.11 is required. Set SCANSCI_PDF_PYTHON to the absolute path of your prepared environment.\n');
  process.exit(1);
}
const child = spawn(executable, ['-I', fileURLToPath(new URL('./run_secure.py', import.meta.url)),
  ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: true, shell: false });
child.on('error', (error) => { process.stderr.write(`Secure Python launch failed: ${error.code}\n`); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
