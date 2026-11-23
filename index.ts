import { MSPNode, installShutdownHooks, mspOptionsFromEnv } from "../shared/msp.ts";
import { WarThunderWorld } from "./world.ts";

export async function startWarThunderNode(): Promise<{ node: MSPNode; world: WarThunderWorld }> {
  const node = new MSPNode(process.env.WT_NODE_ID || "warthunder", mspOptionsFromEnv("WT"));
  const world = new WarThunderWorld({ baseUrl: process.env.WT_URL || "http://127.0.0.1:8111" });
  world.attach(node);
  const ep = await node.start();
  world.start();
  console.log(`[warthunder] MSP node "${node.nodeId}" listening on ${ep.host}:${ep.port}`);
  return { node, world };
}

if (import.meta.main) {
  const { node, world } = await startWarThunderNode();
  installShutdownHooks(() => {
    world.stop();
    node.stop();
  });
}
