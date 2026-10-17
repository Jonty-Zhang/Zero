import { stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

export interface CheckInvocation { executable: string; args: string[] }

export async function resolveCheckInvocation(argv: string[], cwd: string, environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform): Promise<CheckInvocation> {
  const command = argv[0]!;
  const original = { executable: command, args: argv.slice(1) };
  if (platform !== 'win32' || !/^(?:npm|npx)(?:\.(?:cmd|bat))?$/i.test(basename(command))) return original;
  const name = basename(command);
  const tool = name.replace(/\.(?:cmd|bat)$/i, '').toLowerCase();
  const bareName = name.toLowerCase() === tool;
  const explicitPath = /[\\/]/.test(command) || /^[a-z]:/i.test(command);
  const path = environment.PATH ?? environment.Path ?? Object.entries(environment).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const pathDirectories = path.split(';').filter(Boolean).map(directory => resolve(cwd, directory.replace(/^"(.*)"$/, '$1')));
  const commandPath = resolve(cwd, command);
  const directories = explicitPath ? [dirname(commandPath)] : pathDirectories;
  const isFile = async (path: string): Promise<boolean> => stat(path).then(info => info.isFile()).catch(() => false);
  if (explicitPath && !await isFile(commandPath)) throw new Error(`Requested ${tool} command does not exist: ${commandPath}`);
  for (const directory of new Set(directories)) {
    // Preserve a real native command where one exists. Windows cannot launch a
    // .cmd/.bat shim with shell:false, so use the known package's JS entry.
    const native = join(directory, `${tool}.exe`);
    if (!explicitPath && bareName && await isFile(native)) return { executable: native, args: argv.slice(1) };
    if (!explicitPath && !await isFile(join(directory, bareName ? `${tool}.cmd` : name))
      && !(bareName && await isFile(join(directory, `${tool}.bat`)))) continue;
    const entries = [join(directory, 'node_modules', 'npm', 'bin', `${tool}-cli.js`),
      ...(basename(directory).toLowerCase() === '.bin' ? [join(directory, '..', 'npm', 'bin', `${tool}-cli.js`)] : [])];
    for (const entry of entries) if (await isFile(entry)) {
      for (const nodeDirectory of new Set([directory, ...pathDirectories])) {
        const node = join(nodeDirectory, 'node.exe');
        if (await isFile(node)) return { executable: node, args: [entry, ...argv.slice(1)] };
      }
      throw new Error(`Cannot resolve a Node executable for ${tool}; install Node on PATH or beside the requested npm/npx command.`);
    }
  }
  throw new Error(`Cannot resolve ${tool} JavaScript entry for a shell-free Windows check; use an explicit Node executable and the installed ${tool}-cli.js path.`);
}
