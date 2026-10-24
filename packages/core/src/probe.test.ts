import { describe, expect, test } from "bun:test";
import { buildFastProbe } from "./probe";

describe("optional node-local inference authentication", () => {
  test("port 8888 has an unauthenticated fallback when the header file is absent", () => {
    const script = buildFastProbe([{ port: 8888, kind: "metrics" }]);
    expect(script).toContain('if [ -r "$HOME/.config/sparktop/inference-8888.headers" ]');
    expect(script).toContain('-H @"$HOME/.config/sparktop/inference-8888.headers"');
    expect(script).toContain("else curl -s -m 2 'http://127.0.0.1:8888/metrics'; fi;");
    expect(script).toContain("tensorfold:");
    expect(script).toContain("_bucket[{ ]|_created[{ ]");
  });

  test("other ports do not receive this credential", () => {
    const script = buildFastProbe([{ port: 8000, kind: "metrics" }]);
    expect(script).not.toContain("inference-8888.headers");
    expect(script).toContain("http://127.0.0.1:8000/metrics");
  });

  test("OpenAI model discovery uses the same conditional authentication", () => {
    const script = buildFastProbe([{ port: 8888, kind: "openai" }]);
    expect(script).toContain('if [ -r "$HOME/.config/sparktop/inference-8888.headers" ]');
    expect(script).toContain("http://127.0.0.1:8888/v1/models");
    expect(script).not.toContain("Bearer ");
  });
});
