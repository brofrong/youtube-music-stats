/** Extract only watch-history.{html,json} from a Takeout zip. Returns false if the zip has none. */
export async function extractHistory(zip: string, dest: string): Promise<boolean> {
  const proc = Bun.spawn(["unzip", "-o", "-q", zip, "*watch-history.*", "-d", dest], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code === 11) return false; // unzip: "no matching files"
  if (code !== 0) throw new Error(`unzip failed (exit ${code}) for ${zip}`);
  return true;
}
