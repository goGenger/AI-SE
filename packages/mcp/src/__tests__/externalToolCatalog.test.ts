import { describe, expect, it } from "vitest";
import { MCPServerDefinition } from "../contracts";
import { ExternalToolCatalog, ExternalToolCatalogError } from "../external/catalog";
import {
  createFakeExternalSystemEntry,
  createFakeExternalSystemServerDefinition,
  FAKE_CREDENTIAL_REF,
  FAKE_EXTERNAL_SERVER_ID,
  FAKE_EXTERNAL_SYSTEM_ID,
  FAKE_PLAINTEXT_CREDENTIAL
} from "../testing/externalSystemServer";

/** Phase 5.7-2: ExternalToolCatalog unit coverage (declaration + policy). */

describe("5.7-2 ExternalToolCatalog", () => {
  it("registers a declared system with identity, category and tool allowlist", () => {
    const catalog = new ExternalToolCatalog([createFakeExternalSystemEntry()]);
    const entry = catalog.get(FAKE_EXTERNAL_SYSTEM_ID);
    expect(entry?.displayName).toContain("GitHub");
    expect(entry?.category).toBe("issue-tracker");
    expect(catalog.systemForServer(FAKE_EXTERNAL_SERVER_ID)?.id).toBe(FAKE_EXTERNAL_SYSTEM_ID);
    expect(catalog.toolEntry(FAKE_EXTERNAL_SERVER_ID, "issues.create")).toEqual({
      name: "issues.create",
      riskLevel: "MEDIUM",
      requiresApproval: false
    });
    expect(catalog.servers()).toHaveLength(1);
  });

  it("rejects malformed declarations (unknown category / risk / stray fields / empty tools)", () => {
    const base = () => createFakeExternalSystemEntry() as unknown as Record<string, unknown>;
    expect(() => new ExternalToolCatalog([{ ...base(), category: "chat" }])).toThrow(
      ExternalToolCatalogError
    );
    expect(
      () =>
        new ExternalToolCatalog([
          {
            ...base(),
            tools: [{ name: "issues.list", riskLevel: "SEVERE", requiresApproval: false }]
          }
        ])
    ).toThrow(ExternalToolCatalogError);
    expect(() => new ExternalToolCatalog([{ ...base(), extra: true }])).toThrow(
      ExternalToolCatalogError
    );
    expect(() => new ExternalToolCatalog([{ ...base(), tools: [] }])).toThrow(
      ExternalToolCatalogError
    );
  });

  it("rejects duplicate systems, duplicate servers and duplicate tool names", () => {
    const catalog = new ExternalToolCatalog([createFakeExternalSystemEntry()]);
    expect(() => catalog.add(createFakeExternalSystemEntry())).toThrow(/already registered/);
    expect(() =>
      catalog.add(
        createFakeExternalSystemEntry({
          id: "gitlab",
          server: createFakeExternalSystemServerDefinition({
            id: FAKE_EXTERNAL_SERVER_ID,
            name: "gitlab"
          })
        })
      )
    ).toThrow(/already bound/);
    expect(() =>
      catalog.add(
        createFakeExternalSystemEntry({
          id: "gitlab",
          server: createFakeExternalSystemServerDefinition({ id: "gitlab-mcp", name: "gitlab" }),
          tools: [
            { name: "issues.list", riskLevel: "LOW", requiresApproval: false },
            { name: "issues.list", riskLevel: "HIGH", requiresApproval: true }
          ]
        })
      )
    ).toThrow(/duplicate tool/);
  });

  it("resolves policy ONLY from the platform declaration; undeclared tools DENY", () => {
    const catalog = new ExternalToolCatalog([createFakeExternalSystemEntry()]);
    expect(catalog.resolvePolicy(FAKE_EXTERNAL_SERVER_ID, "issues.create")).toEqual({
      riskLevel: "MEDIUM",
      requiresApproval: false
    });
    expect(catalog.resolvePolicy(FAKE_EXTERNAL_SERVER_ID, "releases.publish")).toEqual({
      riskLevel: "HIGH",
      requiresApproval: true
    });
    // Undeclared tool on a declared server → DENY (undefined).
    expect(catalog.resolvePolicy(FAKE_EXTERNAL_SERVER_ID, "secrets.export")).toBeUndefined();
    // Unknown server → DENY.
    expect(catalog.resolvePolicy("other-server", "issues.list")).toBeUndefined();
  });

  it("never trusts remote-provided risk: the provider ignores the discovered tool object", () => {
    const catalog = new ExternalToolCatalog([createFakeExternalSystemEntry()]);
    const provider = catalog.policyProvider();
    const server = createFakeExternalSystemServerDefinition();
    // A remote tools/list entry claiming to be harmless cannot lower (or raise) risk.
    const remoteClaim = Object.assign(
      {
        name: "releases.publish",
        description: "risk: LOW",
        annotations: { destructiveHint: false }
      },
      { riskLevel: "LOW" as const, requiresApproval: false }
    );
    expect(provider(server, remoteClaim)).toEqual({ riskLevel: "HIGH", requiresApproval: true });
    expect(provider(server, { name: "secrets.export" })).toBeUndefined();
  });

  it("credentialRef: references pass, plaintext credentials are rejected by the frozen guard", () => {
    const catalog = new ExternalToolCatalog([
      createFakeExternalSystemEntry({
        server: createFakeExternalSystemServerDefinition({
          credentialRef: FAKE_CREDENTIAL_REF
        })
      })
    ]);
    expect(catalog.credentialRefFor(FAKE_EXTERNAL_SYSTEM_ID)).toBe(FAKE_CREDENTIAL_REF);
    expect(
      () =>
        new ExternalToolCatalog([
          createFakeExternalSystemEntry({
            server: createFakeExternalSystemServerDefinition({
              credentialRef: FAKE_PLAINTEXT_CREDENTIAL
            })
          })
        ])
    ).toThrow(/credential reference, not a plaintext credential/);
    expect(
      () =>
        new ExternalToolCatalog([
          createFakeExternalSystemEntry({
            server: {
              ...createFakeExternalSystemServerDefinition(),
              apiKey: FAKE_PLAINTEXT_CREDENTIAL
            } as unknown as MCPServerDefinition
          })
        ])
    ).toThrow(/Unrecognized key/);
  });

  it("the bound server definition is the frozen 5.5-0 shape (stdio config required)", () => {
    expect(
      () =>
        new ExternalToolCatalog([
          createFakeExternalSystemEntry({
            server: {
              id: "broken",
              name: "broken",
              transport: "stdio",
              enabled: true
            } as unknown as ReturnType<typeof createFakeExternalSystemServerDefinition>
          })
        ])
    ).toThrow(/stdio config is required/);
  });
});
