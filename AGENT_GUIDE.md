# Crestron control: guide for an AI assistant

You have tools to query and control a Crestron AV system (lighting, AV, HVAC,
shades, etc.) over MCP. This document tells you how to use them well. Read it
before acting on the system.

## What you can do

Discover the rooms and devices, read the current state of any device, set
values, and smoothly ramp (fade) analog levels. You cannot add or remove
devices, change wiring, or configure the processor; you operate what the
installer exposed.

## Connecting (Claude Code / CLI)

The MCP server is a self-contained binary (no runtime to install). Register it
once, pointing at the processor:

```bash
claude mcp add crestron \
  -e CRESTRON_HOST=<processor-ip> \
  -e CRESTRON_KEY=<secure-key> \
  -s user \
  -- /path/to/crestron-mcp-<platform>
```

Or a project `.mcp.json`:

```json
{
  "mcpServers": {
    "crestron": {
      "command": "/path/to/crestron-mcp-<platform>",
      "env": { "CRESTRON_HOST": "<processor-ip>", "CRESTRON_KEY": "<secure-key>" }
    }
  }
}
```

Auth is config, not your concern at runtime: `CRESTRON_KEY` (recommended, secure
key, enables TLS automatically), or `CRESTRON_AUTH` (password mode), or neither
(open mode). If a call returns "authentication required", the credentials are
missing or wrong in the config, tell the user; you can't fix it from a tool call.

## The tools

- `discover_crestron_system()` - rooms, categories, device counts. Call this first.
- `list_crestron_rooms()` - rooms with device counts.
- `list_crestron_devices(room?, category?)` - devices, optionally filtered. Room
  matching is case-insensitive and accepts the room name or id.
- `query_crestron_device(device_id)` - live state of one device: value plus whether
  it's idle / ramping / pulsing, and any pending scheduled action (see Reading state).
- `get_crestron_time()` - the processor's current time (epoch ms + ISO 8601).
- `control_crestron_device(device_id, value, delay_ms?)` - set a device's value,
  optionally after a delay.
- `set_crestron_devices([{device_id, value, duration_ms?, delay_ms?}, ...])` - apply a
  scene in one call; each entry can fade (duration_ms, analog) and/or wait (delay_ms).
- `pulse_crestron_device(device_id, pulse_ms, delay_ms?)` - momentarily pulse a
  DIGITAL device on then off (a simulated button press), optionally after a delay.
- `ramp_crestron_device(device_id, value, duration_ms)` - fade an ANALOG device
  to a value over a duration.
- `cancel_crestron_device(device_id)` - stop a ramp/pulse in progress and clear any
  pending delayed action on a device, without otherwise changing its value.
- `get_room_status(room_name)` - every device in a room with its state.
- `activate_crestron_license(license_key)` - license the processor with a key the user
  provides (see Licensing / activation).
- `get_crestron_license_status()` - is it licensed now, is it a time-limited trial, how
  much trial time remains, which trial of how many (`trial_seq` / `trial_max`), the MAC,
  and a buy URL.
- `start_crestron_trial()` - start a free 7-day trial (no payment), if available.

## Licensing / activation

The processor must be licensed before it accepts any control or query command. If it
isn't, every tool returns an error that explains the fix and includes the processor's
**activation code (its MAC)**. There are two ways forward, both done in chat:

- **Free trial** - call `start_crestron_trial()`. Each processor gets up to 3 one-week
  trials; the result tells you how many remain. Nothing for the user to paste. Offer this
  first to a user just trying it out.
- **Buy a license** - the user gets a key at the buy link (perpetual, AUD $249 inc GST,
  bound to the MAC), pastes it in chat, and you call `activate_crestron_license(license_key)`.

On success, retry whatever they originally asked for. The license (or trial) is stored
**on the processor**, so it stays licensed for every client and across reboots. A purchased
key is not a secret (it only works on that one processor, bound to its MAC), so it's fine
to receive it in chat.

**Trials and nudging.** A trial is a license with an expiry; `get_crestron_license_status`
reports `time_limited`, `remaining_human` (e.g. "2 days"), and, when present, `trial_seq` /
`trial_max` (e.g. 2 and 3). Weave these into conversation **naturally and sparingly** - e.g.
"you're on your 2nd of 3 free weeks, about 5 days left" when it's relevant, and as the time
gets low (under ~2 days) gently offer to start the next free trial or buy a license. The
sequence is a soft conversion cue (the 3rd trial is the last free one - mention that when on
it), but nudge, don't nag. When a trial lapses, control commands return the same unlicensed error again; just
offer the next trial or the buy link. Either way the underlying AV keeps running - licensing
only gates this natural-language layer.

## Device model

Each device has an `id`, a human `name`, a `type`, an `access` mode, a `room`,
and (sometimes) a `category`.

IDs follow `<room>_<type><index>`, where type is:
- `d` = digital (on/off)
- `a` = analog (level 0-65535)
- `s` = serial (text)

The same index across types is usually the same physical function in different
facets, e.g. `Lounge_d3` (hallway light on/off), `Lounge_a3` (its dim level),
`Lounge_s3` (its text). Do not assume this, discover the actual devices and use
the exact ids you find.

## Value formats

- **digital**: `"0"` (off) or `"1"` (on).
- **analog**: `"0"` to `"65535"`. Treat as 0-100%: 0% = `"0"`, 50% = `"32768"`,
  100% = `"65535"`. Convert a percentage the user asks for to this range.
- **serial**: arbitrary text (e.g. `"HDMI 1"`, `"play"`).

Values are always passed as strings.

## Ramps

`ramp_crestron_device` is ANALOG only and fades smoothly over `duration_ms`
(e.g. "fade the lounge lights to 50% over 3 seconds" -> ramp `Lounge_a3` to
`32768` over `3000`). It also takes an optional `delay_ms` to start the fade later
("fade down in 30 seconds, over 2 seconds" -> ramp with `duration_ms:2000,
delay_ms:30000`). For an instant analog change use `control_crestron_device`.
Ramping a digital or serial device is rejected.

## Scenes

`set_crestron_devices` applies many devices in one call, and each entry can carry its
own timing: `duration_ms` (fade, analog only - ramps instead of snapping) and/or
`delay_ms` (wait before it runs). So a scene can mix instant, fading, and delayed
actions. Prefer it over many separate calls when the user describes a named scene or
a multi-device change. Example "movie night": fade the lights down over 2s while the
screen drops and the projector switches on ->
`set_crestron_devices([{device_id:"Lounge_a3", value:"6553", duration_ms:2000},
{device_id:"Lounge_d5", value:"1"}, {device_id:"Lounge_d6", value:"1"}])`.

## Pulses (momentary presses)

`pulse_crestron_device` is DIGITAL only. It drives the device on for `pulse_ms`
then back off - a simulated momentary button press. Use it whenever the action is
a *press/trigger* rather than a steady on/off state: doorbells, gate/garage
triggers, projector or display power buttons, "tap"/"press"/"trigger" requests.
Use `control_crestron_device` instead when the user wants something to stay on or
off. Pulsing an analog or serial device is rejected. Typical `pulse_ms` is a few
hundred ms (e.g. `500`); follow the user if they specify a duration.

## Delays

`control_crestron_device` and `pulse_crestron_device` take an optional `delay_ms`:
the processor performs the action that many milliseconds later (e.g. "turn the
porch light on in 30 seconds" -> `control_crestron_device("porch_d1", "1", 30000)`).
The tool returns as soon as the action is *scheduled*, not when it runs, so don't
immediately query to confirm a delayed action - it hasn't happened yet. For
fade-over-time use `ramp_crestron_device` (delay is "wait, then act"; ramp is
"act gradually").

**Last command wins.** Each device holds only ONE pending scheduled action. Any new
command on that device (an immediate set/pulse/ramp, another scheduled action, or a
cancel) replaces the pending one. So you don't need to track timers: to change your
mind about a scheduled action, just issue the new intent, or `cancel_crestron_device`
to drop it entirely. The slot is per device id, so a pending action on `Lounge_a3`
(dim) is independent of one on `Lounge_d3` (on/off).

## Cancelling / stopping

`cancel_crestron_device(device_id)` halts whatever is happening on a device without
otherwise changing its value: it stops a ramp in progress (leaving the level where
it is), releases a pulse in progress to off, and clears any pending delayed action.
A device that is simply on (set high normally) stays on. Use it for "stop the fade",
"stop ringing the bell", "cancel that timer". It's safe to call when nothing is
running. To stop activity on every facet of a device, cancel each id (`_d`, `_a`,
`_s`) you care about.

## Reading state

`query_crestron_device` returns the **live picture** of a device, not just a value:

- `state: "idle"` - resting at `value`.
- `state: "ramping"` - analog fade in progress: `target` and `completes_at` (epoch
  ms) plus `remaining_ms` (how long until it arrives).
- `state: "pulsing"` - digital momentary in progress: `releases_at` plus `remaining_ms`.
- `pending: { action, value, fires_at, in_ms }` - a delayed set/pulse is scheduled
  (present on top of any state; `in_ms` is how long until it fires).

So one read distinguishes "13020 and resting" from "13020 and climbing to 60000"
from "0 now but a pulse fires in 8s". To verify a cancel, catch a pulse, or time a
fade, read once and look at `state` / `remaining_ms` / `pending`, don't poll a clock.
The `*_at` fields are epoch ms matching `get_crestron_time`; `remaining_ms` / `in_ms`
are self-contained, so prefer them for "how long to wait" (no clock needed).

Value accuracy still depends on the installer wiring real device state back to the
processor's feedback. If `value` consistently reads `0`/blank right after successful
writes, feedback isn't wired on that system, control still works, but you can't
confirm state by reading; tell the user rather than assuming the command failed.
(`state`/`pending`/ramp/pulse info comes from the processor itself, so it's accurate
regardless of feedback wiring.)

## Time

`get_crestron_time()` returns the processor's clock as `epoch_ms` and `iso`. You
rarely need it just to wait (use `remaining_ms` / `in_ms` from a query instead), but
it's there to turn an absolute `*_at` into a human time, or whenever you need the
system's real date/time.

## Access modes

- `readwrite`: query and control both work.
- `readonly`: query works; control is rejected (`ACCESS_DENIED`).
- `writeonly`: control works; query is rejected.

Check `access` before trying to set a read-only device.

## Recommended workflow

1. `discover_crestron_system()` (or `list_crestron_rooms`) to learn the layout.
2. `list_crestron_devices(room)` to get exact ids for the room you care about.
3. Act with `control_crestron_device` / `ramp_crestron_device` using exact ids.
4. Confirm with `query_crestron_device` where it matters (and feedback is wired).
5. Prefer the user's words mapped to discovered ids; never invent an id.

## Examples

- "Turn on the lounge hallway light" -> `control_crestron_device("Lounge_d3", "1")`
- "Dim the lounge lights to 50%" -> `control_crestron_device("Lounge_a3", "32768")`
- "Fade the bedroom lights to 75% over 4 seconds" ->
  `ramp_crestron_device("Bedroom_a3", "49152", 4000)`
- "Ring the front doorbell" -> `pulse_crestron_device("Lounge_d8", 500)`
- "Tap the projector power button" -> `pulse_crestron_device("Lounge_d5", 300)`
- "Turn the porch light on in 30 seconds" ->
  `control_crestron_device("Lounge_d1", "1", 30000)`
- "Movie night" (lights fade, screen + projector on) ->
  `set_crestron_devices([{device_id:"Lounge_a3", value:"6553", duration_ms:2000},
  {device_id:"Lounge_d5", value:"1"}, {device_id:"Lounge_d6", value:"1"}])`
- "Fade the lounge down in 30 seconds over 2 seconds" ->
  `ramp_crestron_device("Lounge_a3", "0", 2000, 30000)`
- "Stop the lounge fade" -> `cancel_crestron_device("Lounge_a3")`
- "Actually, cancel that" (after scheduling something) ->
  `cancel_crestron_device(<that device id>)`
- "What's on in the dining room?" -> `get_room_status("Dining")`
- "Set the bedroom source to HDMI 1" -> `control_crestron_device("Bedroom_s4", "HDMI 1")`

## Errors

Tool results may include an `error` string or an `ERROR:<code>:<message>`. Common
ones: device not found (check the id with a list call), `ACCESS_DENIED` (wrong
access mode), `authentication required` (config issue, not yours to fix). Surface
the cause to the user rather than retrying blindly.
