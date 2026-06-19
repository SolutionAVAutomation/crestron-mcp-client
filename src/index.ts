#!/usr/bin/env node
/**
 * Crestron MCP Server (Node/TypeScript)
 *
 * Exposes a Crestron 4-Series system to Claude over MCP. Connects to the
 * processor (or the simulator) using the text protocol in PROTOCOL.md.
 *
 * Transport is stdio (the standard way an MCP client launches a local server),
 * so NOTHING may be written to stdout except the MCP protocol itself; all
 * diagnostics go to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CrestronConnection } from "./connection.js";
import { loadConfig } from "./config.js";

const cfg = loadConfig();
const crestron = new CrestronConnection(cfg.host, cfg.port, cfg.auth, cfg.key, cfg.tls);

const server = new McpServer({ name: "crestron-control", version: "1.8.1" });

const ok = (obj: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
});
const fail = (e: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
});

server.registerTool(
  "discover_crestron_system",
  {
    description:
      "Discover the devices and capabilities available in the Crestron system. " +
      "Returns rooms, categories, and device counts.",
  },
  async () => {
    try {
      return ok(await crestron.discoverSystem());
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "list_crestron_rooms",
  { description: "List all rooms in the building with their device counts." },
  async () => {
    try {
      return ok(await crestron.listRooms());
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "list_crestron_devices",
  {
    description:
      "List controllable devices, optionally filtered by room and/or category " +
      "(Lighting, AV, HVAC, Shades).",
    inputSchema: {
      room: z.string().optional().describe("Optional room name or id to filter by."),
      category: z.string().optional().describe("Optional category to filter by (Lighting, AV, HVAC, Shades)."),
    },
  },
  async ({ room, category }) => {
    try {
      return ok(await crestron.listDevices(room, category));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "query_crestron_device",
  {
    description:
      "Get the live state of a device: its current value plus whether it is idle, ramping " +
      "(with target and completes_at), or pulsing (releases_at), and any pending scheduled action " +
      "(with fires_at). Time fields are epoch milliseconds (matching get_crestron_time); " +
      "remaining_ms / in_ms tell you directly how long until it finishes/fires, so you can decide " +
      "how long to wait without polling a clock. One read tells you idle vs in-flight vs scheduled.",
    inputSchema: {
      device_id: z.string().describe('Unique device identifier (e.g. "conf_rm_a_lights_on").'),
    },
  },
  async ({ device_id }) => {
    try {
      return ok(await crestron.queryDevice(device_id));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_crestron_time",
  {
    description:
      "Get the processor's current time as epoch milliseconds (epoch_ms) and ISO 8601 (iso). Use " +
      "it to correlate the absolute *_at timestamps from query_crestron_device, or whenever you " +
      "need the system's real time (no need to decode a wired clock).",
  },
  async () => {
    try {
      return ok(await crestron.getTime());
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "control_crestron_device",
  {
    description:
      "Set a device's value. Optionally schedule it to run after a delay (delay_ms), e.g. " +
      '"turn the porch light on in 30 seconds". The result confirms the outcome: a "status" ' +
      'summary (e.g. "now 50000", or "feedback reads X (set Y)" if it differs, or "scheduled to ' +
      'set ... in ~30s") plus the full "confirmed" state, so you can see what actually happened ' +
      "without a separate query.",
    inputSchema: {
      device_id: z.string().describe('Unique device identifier (e.g. "conf_rm_a_lights_on").'),
      value: z.string().describe('New value - digital "0"/"1", analog "0"-"65535", or serial text.'),
      delay_ms: z
        .number()
        .int()
        .optional()
        .describe("Optional delay in milliseconds before the set runs on the processor (0 / omit = immediate)."),
    },
  },
  async ({ device_id, value, delay_ms }) => {
    try {
      return ok(await crestron.setDevice(device_id, value, delay_ms ?? 0));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "set_crestron_devices",
  {
    description:
      "Apply a scene/macro: set many devices in one call. Each entry can optionally fade " +
      "(duration_ms, analog only - the device ramps to value instead of snapping) and/or start " +
      'after a wait (delay_ms). Use for "movie night" (fade lights down over 2s + lower screen + ' +
      "projector on) or staged sequences. Values follow control_crestron_device rules " +
      "(digital/analog/serial). A plain (no-timing) value may contain colons but not commas. " +
      'Each result entry carries a "status" summary and "confirmed" state for that device.',
    inputSchema: {
      assignments: z
        .array(
          z.object({
            device_id: z.string().describe('Device id, e.g. "lounge_d1".'),
            value: z.string().describe('Value - digital "0"/"1", analog "0"-"65535", or serial text.'),
            duration_ms: z
              .number()
              .int()
              .optional()
              .describe("Optional fade time in ms (ANALOG only); the device ramps to value over this time instead of snapping."),
            delay_ms: z
              .number()
              .int()
              .optional()
              .describe("Optional wait in ms before this entry runs (works for set, fade, pulse-via-value)."),
          }),
        )
        .describe("The devices to set, each {device_id, value, duration_ms?, delay_ms?}."),
    },
  },
  async ({ assignments }) => {
    try {
      return ok(await crestron.setDevices(assignments));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "pulse_crestron_device",
  {
    description:
      "Momentarily pulse a DIGITAL device: drive it on for pulse_ms, then back off - a simulated " +
      'button press. Use for momentary triggers like "press the doorbell", "tap the projector power ' +
      'button", "trigger the gate". Optionally wait delay_ms before the pulse. Digital devices only; ' +
      "analog and serial devices are rejected (use control_crestron_device / ramp_crestron_device). " +
      'The result includes a "status" (e.g. "pulsing, releases in ~500ms") plus "confirmed" state.',
    inputSchema: {
      device_id: z.string().describe('Unique digital device identifier (e.g. "lounge_d3").'),
      pulse_ms: z.number().int().describe("How long to hold it on, in milliseconds (e.g. 500)."),
      delay_ms: z
        .number()
        .int()
        .optional()
        .describe("Optional delay in milliseconds before the pulse starts (0 / omit = immediate)."),
    },
  },
  async ({ device_id, pulse_ms, delay_ms }) => {
    try {
      return ok(await crestron.pulseDevice(device_id, pulse_ms, delay_ms ?? 0));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "cancel_crestron_device",
  {
    description:
      "Stop/cancel activity on a device: stop a ramp (fade) in progress and leave the level where " +
      "it is, release a pulse in progress to off, and clear any pending delayed action (a scheduled " +
      "set or pulse). Does not otherwise change the device's value - a device that is simply on/high " +
      'from a normal set stays on. Use for "stop the fade", "stop ringing the bell", "cancel that ' +
      'timer". Works on any device type.',
    inputSchema: {
      device_id: z.string().describe('Unique device identifier (e.g. "lounge_a3").'),
    },
  },
  async ({ device_id }) => {
    try {
      return ok(await crestron.cancelDevice(device_id));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "ramp_crestron_device",
  {
    description:
      'Smoothly ramp (fade) an ANALOG device to a value over a duration. Use for requests like ' +
      '"fade the lounge lights to 50% over 3 seconds". Optionally start the fade after delay_ms ' +
      '("fade down in 30 seconds, over 2 seconds"). Analog devices only; digital and serial ' +
      "devices don't ramp - use control_crestron_device for those (and for an instant analog set). " +
      'The result includes a "status" like "fading to 50000, ~3s left" plus "confirmed" state.',
    inputSchema: {
      device_id: z.string().describe('Unique device identifier (e.g. "lounge_a1").'),
      value: z.string().describe('Target analog value "0"-"65535".'),
      duration_ms: z.number().int().describe("Ramp duration in milliseconds (e.g. 3000 for 3 seconds)."),
      delay_ms: z
        .number()
        .int()
        .optional()
        .describe("Optional delay in ms before the fade starts (0 / omit = immediate)."),
    },
  },
  async ({ device_id, value, duration_ms, delay_ms }) => {
    try {
      return ok(await crestron.rampDevice(device_id, value, duration_ms, delay_ms ?? 0));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_room_status",
  {
    description: "Get the status of every device in a room.",
    inputSchema: {
      room_name: z.string().describe('Room name or id (e.g. "Conference Room A" or "conf_rm_a").'),
    },
  },
  async ({ room_name }) => {
    try {
      const devices = (await crestron.listDevices(room_name)) as unknown[];
      return ok({ room: room_name, device_count: devices.length, devices });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "activate_crestron_license",
  {
    description:
      "Activate (license) the Crestron processor with a license key the user provides. Use this " +
      "when a command fails because the processor isn't licensed: the error explains how, and " +
      "shows the processor's activation code (MAC). Ask the user for the license key issued for " +
      "that code, then call this with it. Activation is one-time - the key is stored on the " +
      "processor, so it stays licensed for every client and across reboots. The key is not a " +
      "secret (it only works on this one processor), so it's fine to receive it in chat.",
    inputSchema: {
      license_key: z.string().describe("The license key the user obtained for this processor."),
    },
  },
  async ({ license_key }) => {
    try {
      return ok(await crestron.activateLicense(license_key));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_crestron_license_status",
  {
    description:
      "Check the processor's license/trial state: whether it's licensed right now, whether that's a " +
      "time-limited free trial (time_limited), how much trial time remains (remaining_human / " +
      "remaining_ms), the processor MAC, and a buy_url. Call it to orient at the start of a session " +
      "and whenever license status is relevant. If it's a trial, mention the remaining time naturally; " +
      "as it gets low (under ~2 days) gently offer to start another free trial or buy a license. " +
      "Nudge, don't nag.",
  },
  async () => {
    try {
      return ok(await crestron.licenseStatus());
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "start_crestron_trial",
  {
    description:
      "Start a free 7-day trial on this processor - no payment, no card, nothing for the user to " +
      "paste. It contacts Solution AV's licensing server, which mints a signed trial bound to the " +
      "processor's MAC and counts it there (this enforces the per-processor limit); the only data " +
      "sent is the MAC, and the signed trial is then stored on the processor. If asked, describe it " +
      "accurately (issued and counted online by the licensing server, then stored on the box) and do " +
      "not claim nothing happens online. Use it when the processor is unlicensed, or when a trial has " +
      "lapsed and the user wants to keep going. Each processor gets up to 3 one-week trials; this " +
      "reports trials_remaining and the expiry after starting one. When the trials are used up the " +
      "result carries buy_url (with the MAC pre-filled) and a next_step; present that full link to " +
      "the user right away, don't wait to be asked for it. The underlying AV keeps working " +
      "regardless; licensing only gates this natural-language layer.",
  },
  async () => {
    try {
      return ok(await crestron.startTrial());
    } catch (e) {
      return fail(e);
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `crestron-mcp: ready (target ${cfg.host}:${cfg.port}, ` +
      `${cfg.key ? "mode 2 key" : cfg.auth ? "mode 1 password" : "open"}${cfg.tls ? " + TLS" : ""})`,
  );
}

main().catch((e) => {
  console.error("crestron-mcp: fatal", e);
  process.exit(1);
});
