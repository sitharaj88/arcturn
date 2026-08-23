import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  getPrompt,
  listPrompts,
  listResources,
  listResourceTemplates,
  readResource,
} from "./resources.js";
import { createTestServer, type TestServerHandle } from "./test-support.js";

describe("resources & prompts", () => {
  let handle: TestServerHandle;
  let client: Client;

  afterEach(async () => {
    await client?.close();
    await handle?.server.close();
  });

  async function connect(
    options: Parameters<typeof createTestServer>[0] = {},
  ): Promise<ReadonlyMap<string, Client>> {
    handle = createTestServer(options);
    client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(handle.clientTransport);
    return new Map([["myserver", client]]);
  }

  it("lists resources for a named server", async () => {
    const clients = await connect();
    const resources = await listResources(clients, "myserver");
    expect(resources).toEqual([
      {
        server: "myserver",
        uri: "test://greeting.txt",
        name: "greeting",
        description: undefined,
        mimeType: "text/plain",
      },
    ]);
  });

  it("lists resources across every server when none is named", async () => {
    const clients = await connect();
    const resources = await listResources(clients);
    expect(resources).toHaveLength(1);
    expect(resources[0]?.server).toBe("myserver");
  });

  it("reads a text resource", async () => {
    const clients = await connect();
    const c = clients.get("myserver");
    if (!c) throw new Error("missing client");
    const contents = await readResource(c, "test://greeting.txt");
    expect(contents).toEqual([
      { uri: "test://greeting.txt", mimeType: "text/plain", text: "hello there", blob: undefined },
    ]);
  });

  it("lists prompts", async () => {
    const clients = await connect();
    const prompts = await listPrompts(clients, "myserver");
    expect(prompts).toEqual([
      {
        server: "myserver",
        name: "greet",
        description: "Greets someone",
        arguments: [{ name: "who" }],
      },
    ]);
  });

  it("fetches a prompt and flattens messages to {role, text} pairs", async () => {
    const clients = await connect();
    const c = clients.get("myserver");
    if (!c) throw new Error("missing client");
    const messages = await getPrompt(c, "greet", { who: "Ada" });
    expect(messages).toEqual([{ role: "user", text: "Say hi to Ada" }]);
  });

  it("throws a clear error when the named server is not in the client map", async () => {
    const clients = await connect();
    await expect(listResources(clients, "nope")).rejects.toThrow(/nope/);
  });

  it("follows pagination to exhaustion when listing resources", async () => {
    const threeResources = [
      { uri: "test://a.txt", name: "a", mimeType: "text/plain" },
      { uri: "test://b.txt", name: "b", mimeType: "text/plain" },
      { uri: "test://c.txt", name: "c", mimeType: "text/plain" },
    ];
    const clients = await connect({ resources: threeResources, resourcePageSize: 1 });
    const resources = await listResources(clients, "myserver");
    expect(resources.map((r) => r.uri)).toEqual(["test://a.txt", "test://b.txt", "test://c.txt"]);
  });

  it("follows pagination to exhaustion when listing prompts", async () => {
    const threePrompts = [
      { name: "p1", description: "one" },
      { name: "p2", description: "two" },
      { name: "p3", description: "three" },
    ];
    const clients = await connect({ prompts: threePrompts, promptPageSize: 1 });
    const prompts = await listPrompts(clients, "myserver");
    expect(prompts.map((p) => p.name)).toEqual(["p1", "p2", "p3"]);
  });

  it("lists resource templates for a named server", async () => {
    const clients = await connect({
      resourceTemplates: [
        {
          uriTemplate: "test://{id}.txt",
          name: "byId",
          description: "Fetch a resource by id",
          mimeType: "text/plain",
        },
      ],
    });
    const templates = await listResourceTemplates(clients, "myserver");
    expect(templates).toEqual([
      {
        server: "myserver",
        uriTemplate: "test://{id}.txt",
        name: "byId",
        description: "Fetch a resource by id",
        mimeType: "text/plain",
      },
    ]);
  });

  it("follows pagination to exhaustion when listing resource templates", async () => {
    const threeTemplates = [
      { uriTemplate: "test://a/{id}", name: "a" },
      { uriTemplate: "test://b/{id}", name: "b" },
      { uriTemplate: "test://c/{id}", name: "c" },
    ];
    const clients = await connect({
      resourceTemplates: threeTemplates,
      resourceTemplatePageSize: 1,
    });
    const templates = await listResourceTemplates(clients, "myserver");
    expect(templates.map((t) => t.uriTemplate)).toEqual([
      "test://a/{id}",
      "test://b/{id}",
      "test://c/{id}",
    ]);
  });

  it("throws a clear error for listResourceTemplates when the named server is not connected", async () => {
    const clients = await connect();
    await expect(listResourceTemplates(clients, "nope")).rejects.toThrow(/nope/);
  });
});
