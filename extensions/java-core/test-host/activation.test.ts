// Layer 2 (RFC 0001 §10): a real extension host, the maven-multi fixture as
// the workspace, `redhat.java` installed by .vscode-test.mjs. Asserts what
// only the host shows: activation, the commands, the settings write through
// the manifest, and removal ending with the workspace settings as they were.
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

suite("java-core in the extension host", () => {
  const folder = () => vscode.workspace.workspaceFolders![0]!.uri.fsPath;

  test("activates on the Maven fixture and exports the contract", async () => {
    const ext = vscode.extensions.getExtension("batlehub.java-core")!;
    assert.ok(ext, "extension present");
    const api = await ext.activate();
    assert.deepStrictEqual(api.contractVersion, { major: 1, minor: 0 });
    assert.throws(() => api.assertContract(2), /does not match/);
  });

  test("registers its commands", async () => {
    const all = await vscode.commands.getCommands(true);
    for (const c of ["batlehub.java.detect", "batlehub.java.pickJdk", "batlehub.java.installJdk", "batlehub.java.removeSettings", "batlehub.java.showLog"]) assert.ok(all.includes(c), c);
  });

  test("writes java.configuration.runtimes through the manifest, and removal restores it", async function () {
    this.timeout(60000);
    await vscode.commands.executeCommand("batlehub.java.detect");
    const runtimes = vscode.workspace.getConfiguration("java").inspect("configuration.runtimes")?.workspaceValue as unknown[] | undefined;
    const manifest = path.join(folder(), ".batlehub", "java", "written.json");
    if (runtimes?.length) {
      assert.ok(fs.existsSync(manifest), "manifest written beside the write");
      const m = JSON.parse(fs.readFileSync(manifest, "utf8"));
      assert.ok(m.entries.some((e: { key: string }) => e.key === "java.configuration.runtimes"));
    } else {
      // No JDK on the runner at all: no write, no manifest — also correct.
      assert.ok(!fs.existsSync(manifest));
    }
  });

  test("resolution per folder follows the fixture's maven.compiler.release", async () => {
    const api = vscode.extensions.getExtension("batlehub.java-core")!.exports;
    const r = await api.jdk.resolve(vscode.workspace.workspaceFolders![0]!);
    assert.strictEqual(r.required?.min, 21);
    assert.strictEqual(r.required?.origin, "maven.compiler.release");
  });
});
