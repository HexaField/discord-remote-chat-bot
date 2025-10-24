import { exec as cpExec } from "node:child_process";
import util from "node:util";
import fs from "node:fs";

const exec = util.promisify(cpExec);

function escapePath(p: string) {
  return `"${p.replace(/"/g, '\\"')}"`;
}

export async function ensureWhisperAvailable() {
  try {
    await exec("whisper-cli --help");
  } catch (err) {
    throw new Error("whisper-cli not available on PATH");
  }
}

/**
 * Run whisper-cli to transcribe a WAV file to a TXT file.
 * - modelPath: path to ggml model
 * - wavPath: input wav file
 * - outTxtPath: expected output txt path (whisper-cli writes `<of>-transcript.txt` sometimes; to keep things simple we follow the original CLI flags and check the provided out file)
 * - outBase: base path (without extension) to pass to whisper-cli -of flag
 */
export async function transcribeWithWhisper(
  modelPath: string,
  wavPath: string,
  outTxtPath: string,
  outBase: string
) {
  const cmd = `whisper-cli -m ${escapePath(modelPath)} -f ${escapePath(
    wavPath
  )} -otxt -of ${escapePath(outBase)}`;
  await exec(cmd, { maxBuffer: 20 * 1024 * 1024 });

  // Ensure expected file exists
  if (!fs.existsSync(outTxtPath)) {
    throw new Error(`Whisper did not produce transcript at ${outTxtPath}`);
  }
}
