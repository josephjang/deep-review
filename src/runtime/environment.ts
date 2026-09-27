/**
 * The worker's environment: what the launcher pins for every runtime, and
 * helpers that compare variable names the way the worker's platform does:
 * case-insensitively on Windows, exactly everywhere else.
 *
 * Windows treats `Path` and `PATH` as one variable, but a Node environment
 * object can hold both. Node then passes the child only one of them, the
 * spelling that sorts first by code unit (`PATH` before `Path`), whichever
 * one the caller set; so on Windows a pin removes every spelling before it
 * sets its own. On POSIX `Temp` and `TEMP` are two variables, and a program
 * that reads one never sees the other, so each is left alone.
 */

/** The name as the platform compares it. */
function comparable(name: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? name.toUpperCase() : name;
}

/** Every spelling of `name` present in the environment that the platform takes for it, with its value. */
export function spellingsOf(environment: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): [string, string | undefined][] {
  const wanted = comparable(name, platform);
  return Object.entries(environment).filter(([key]) => comparable(key, platform) === wanted);
}

/** A copy of the environment without any spelling the platform takes for one of the given names. */
export function withoutVariables(environment: NodeJS.ProcessEnv, names: readonly string[], platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const removed = new Set(names.map((name) => comparable(name, platform)));
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !removed.has(comparable(key, platform))));
}

/** A copy of the environment with each value set under exactly the given spelling, every other spelling the platform takes for it removed. */
export function pinVariables(environment: NodeJS.ProcessEnv, values: Readonly<Record<string, string>>, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  return { ...withoutVariables(environment, Object.keys(values), platform), ...values };
}

/**
 * Toolchains that keep a build server alive after the command that started
 * it; a surviving server is the descendant every pilot saw outlive a worker
 * (PD2). MSBuild reads the last two as properties, so they reach nested builds.
 */
export const buildServerPins: Readonly<Record<string, string>> = {
  MSBUILDDISABLENODEREUSE: '1',
  DOTNET_CLI_USE_MSBUILD_SERVER: '0',
  UseSharedCompilation: 'false',
  UseRazorBuildServer: 'false',
};

/** The environment of the spawned process: the adapter's, with the temporary directory and the build-server pins over every inherited spelling the platform reads as theirs (R8). */
export function workerEnvironment(environment: NodeJS.ProcessEnv, scratch: string | null, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  // TEMP and TMP serve Windows programs; POSIX tools read TMPDIR. On Windows
  // those are Git Bash's, which wants forward slashes; elsewhere a backslash
  // is an ordinary filename character and the path is kept as it is.
  const temporary = scratch === null ? {} : { TEMP: scratch, TMP: scratch, TMPDIR: platform === 'win32' ? scratch.replaceAll('\\', '/') : scratch };
  return pinVariables(environment, { ...buildServerPins, ...temporary }, platform);
}
