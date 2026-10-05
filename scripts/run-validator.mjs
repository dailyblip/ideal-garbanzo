import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Validators are CLI entrypoints: several legitimately call process.exit(0)
// when their source has no published jobs. Run each in its own process so that
// success returns to the caller instead of skipping the remaining gates. Do not
// import entrypoints or share an ESM cache between independent validations.
export async function runValidator(entrypoint) {
  const script = fileURLToPath(entrypoint);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit'
    });
    child.once('error', error => {
      reject(new Error(`Unable to run validator ${script}: ${error.message}`, { cause: error }));
    });
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Validator ${script} failed (${signal ? `signal ${signal}` : `exit ${code}`}).`));
    });
  });
}
