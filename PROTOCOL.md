# MCP-Crestron Protocol Specification v1.0

## Overview

Text-based protocol for AI control of Crestron systems via MCP (Model Context Protocol).

**Design Principles:**
- Human-readable for debugging
- Simple to parse in both C# and Python
- Extensible for future features
- Clear error handling
- Low latency

---

## Connection

**Protocol:** TCP/IP  
**Port:** 50794 (configurable)  
**Encoding:** UTF-8  
**Line Termination:** `\n` (LF)  
**Max Message Size:** 8KB per message  

---

## Message Format

### Command Structure
```
COMMAND[:PARAM1[:PARAM2[:...]]]
```

### Response Structure
```
OK[:data]
ERROR:code:message
DATA:json_string
```

**Rules:**
- Commands and parameters are case-insensitive
- Device IDs are case-sensitive
- The **value** is always the LAST field of a command/response, so it is parsed
  positionally and **may contain colons** (e.g. `SET:dvd_s1:now playing 12:34`). Earlier
  fields (command, device ID, room, category) must not contain colons; device IDs never do.
- `BATCH_SET` pairs are comma-separated and each split on its first colon, so a value in a
  batch may contain colons but **not commas**.
- A value must not contain a raw newline (`\n` is the frame delimiter / line terminator).
- Empty parameters are represented by empty string between colons

---

## Core Commands

### 1. HELLO
**Purpose:** Initial handshake, get system information  
**Format:** `HELLO`

**Response:**
```
OK:MCP-CRESTRON:1.0:PROCESSOR_ID
```

**Example:**
```
Client: HELLO
Server: OK:MCP-CRESTRON:1.0:PROC-CP4-01
```

---

### 1a. AUTH
**Purpose:** Authenticate the connection when the server is in a non-open auth mode  
**Format:** `AUTH:credential` (mode 1) or bare `AUTH` then `AUTH:<digest>` (mode 2)

- **Mode 0 (open):** no `AUTH` needed; any client may issue commands. `AUTH` is still accepted (returns `OK:AUTH`).
- **Mode 1 (password):** the client must send `AUTH:<password>` after `HELLO`; until it succeeds, every command except `HELLO` and `AUTH` is rejected with `ERROR:1009`. The password is sent in plaintext, so this is for a trusted LAN only.
- **Mode 2 (secure key):** runs over **TLS** (the processor listens with `SecureTCPServer`), so the whole channel is encrypted, not just the credential. On top of TLS the client authenticates by HMAC-SHA256 challenge-response: it sends a bare `AUTH` (no argument); the server replies `CHALLENGE:<nonce>` (a one-time random value); the client returns `AUTH:<digest>` where `digest = lowercase-hex( HMAC-SHA256(key, nonce) )`. The server recomputes with its copy of the key and compares in constant time. The nonce is single-use per connection (a failed attempt needs a fresh bare `AUTH`). The same `ERROR:1009` gate applies until authenticated. The processor presents `SecureTCPServer`'s built-in self-signed certificate; on a trusted LAN the client encrypts without verifying it (no PKI). Modes 0 and 1 are plaintext TCP.
- Authentication is per-connection and lasts the life of the TCP connection. The server's mode is set program-side (the `MCP_Server_Config` SIMPL+ module). In mode 2 the processor mints and persists the key and surfaces it on the module's `Key$` output; copy it to the client once. The client supplies its credential via `CRESTRON_AUTH` (mode-1 password) or `CRESTRON_KEY` (mode-2 key) as env vars or in `config.json`; `CRESTRON_KEY` takes precedence and also turns on TLS (set `CRESTRON_TLS=1` to force TLS without a key).

**Response:**
```
CHALLENGE:<nonce>  (mode 2, after a bare AUTH)
OK:AUTH            (authenticated)
ERROR:1010:...     (wrong credential)
```

**Example (mode 1, password):**
```
Client: HELLO
Server: OK:MCP-CRESTRON:1.0:PROC-CP4-01
Client: AUTH:s3cret
Server: OK:AUTH
```

**Example (mode 2, secure key):**
```
Client: HELLO
Server: OK:MCP-CRESTRON:1.0:PROC-CP4-01
Client: AUTH
Server: CHALLENGE:3eaae71c1c862bf21863c0d36cf06558
Client: AUTH:40c3180c8311a87dbf15f9e4b5dc0d1bcf4cbfb4f92d866f5810126a684ce9e1
Server: OK:AUTH
```

---

### 1b. ACTIVATE (licensing)

**Format:** `ACTIVATE:<license>` (alias: `LICENSE:<license>`)

Licensing is **per-processor and stored on the box**. A license is an offline-verifiable token
signed by the vendor's RSA-2048 private key and bound to the processor's MAC. The processor embeds
only the public key; it verifies the signature, checks the license is for its own MAC, and (if
valid) **persists** it to the data store, so the box stays licensed across reboots and for every
client. No network call, no per-connection license exchange.

- The license is **installed once** via `ACTIVATE`, typically through the MCP client's
  `activate_crestron_license` tool: the user pastes the key in chat and the LLM activates the box.
- `ACTIVATE` is allowed before authentication (like `HELLO`/`AUTH`), so an unlicensed box can be
  activated. The license blob is base64url (no colons); whitespace in a pasted key is tolerated.
- When **license enforcement is on**, every command except `HELLO`, `AUTH`, and `ACTIVATE` is
  rejected with `ERROR:1011` until the processor is licensed. The error names the processor's MAC
  (its activation code) so the client can tell the user what to get a key for.
- Enforcement is enabled only if the processor's boot **RSA self-test passes** (so a crypto issue
  disables the gate rather than bricking the box). The license is orthogonal to auth: a command
  must pass **both** the license gate and the auth gate.

**Responses:**
```
OK:ACTIVATED:<customer>   (verified for this processor + persisted)
ERROR:1012:<reason>       (bad signature, wrong MAC, malformed, or expired)
ERROR:1011:license required for this processor (MAC <mac>)   (gated command while unlicensed)
```

**Example:**
```
Client: HELLO
Server: OK:MCP-CRESTRON:1.0:CRESTRON-MCP
Client: LIST_ROOMS
Server: ERROR:1011:license required for this processor (MAC 00107ff0ab17)
Client: ACTIVATE:eyJ2Ijox...<signed license>
Server: OK:ACTIVATED:Acme Integrators
Client: LIST_ROOMS
Server: DATA:[...]
```

### 1c. Trials (time-limited licenses)

A **trial** is just a normal signed license that carries an `expiry` (the vendor issues 7-day
trials, capped per MAC by the licensing server). It activates through the same `ACTIVATE` path and
persists the same way. Two differences from a perpetual license:

- The **signature is verified once** (at boot / on `ACTIVATE`); the **expiry is re-checked on every
  command** (a cheap timestamp compare, no crypto). So a trial lapses on its own at the next command
  with no timer, after which gated commands return `ERROR:1011` again.
- A lapsed trial only re-gates the MCP layer; the underlying control program is unaffected.

The cap (default 3 trials per processor) is enforced by the **licensing server**, not the box; the
box only knows "valid until `<expiry>`". The MCP client's `start_crestron_trial` tool fetches a
signed trial from the server and relays it via `ACTIVATE`.

### 1d. LICENSE_STATUS

**Format:** `LICENSE_STATUS`

Reports the processor's current license state. Allowed before the gates (like `HELLO`), so a client
can detect an unlicensed box and read its MAC. Lets the client surface a trial's remaining time.

**Response:** `DATA:<json>`
```json
{ "licensed": true, "enforced": true, "time_limited": true,
  "remaining_ms": 518400000, "expiry_epoch_ms": 1782432000000,
  "trial_seq": 2, "trial_max": 3,
  "customer": "Trial", "mac": "00107ff0ab17" }
```
`time_limited` is true for a trial; `remaining_ms` / `expiry_epoch_ms` are present only then. For a
perpetual license `time_limited` is false and those fields are omitted. When unlicensed,
`licensed` is false and `mac` still reports the activation code. `trial_seq` / `trial_max` (which
trial this is, 1-based, and the total allowed) appear only on a server-minted trial that carries
them, so the LLM can say "trial 2 of 3".

Licenses are issued with the vendor `licgen` tool (`licgen sign --mac <mac> --customer "<name>"`),
which signs `{mac, customer, tier, issued, expiry?, trial_seq?, trial_max?}`. Perpetual licenses
omit `expiry` (and the trial fields); an `expiry` date, if present, is re-checked on each
boot/verify. The trial fields are appended after `expiry` and minted by the licensing server.

---

### 2. DISCOVER
**Purpose:** Get complete system capabilities  
**Format:** `DISCOVER`

**Response:**
```
DATA:{"processor_id":"PROC-CP4-01","version":"1.0","rooms":[...],"categories":[...],"total_devices":47}
```

**JSON Structure:**
```json
{
  "processor_id": "PROC-CP4-01",
  "version": "1.0",
  "capabilities": ["query", "control", "pulse", "ramp", "delay", "cancel", "batch", "state", "time"],
  "rooms": [
    {
      "id": "conf_rm_a",
      "name": "Conference Room A",
      "device_count": 12
    }
  ],
  "categories": ["Lighting", "AV", "HVAC", "Shades"],
  "total_devices": 47
}
```

---

### 3. LIST_ROOMS
**Purpose:** Get list of all rooms  
**Format:** `LIST_ROOMS`

**Response:**
```
DATA:[{"id":"conf_rm_a","name":"Conference Room A","device_count":12},...]
```

---

### 4. LIST_DEVICES
**Purpose:** Get all devices, optionally filtered by room or category  
**Format:** 
- `LIST_DEVICES` - All devices
- `LIST_DEVICES:room_id` - Devices in specific room
- `LIST_DEVICES:room_id:category` - Devices in room and category

**Response:**
```
DATA:[{"id":"conf_rm_a_lights","type":"analog","name":"Lights",...},...]
```

**JSON Device Structure:**
```json
{
  "id": "conf_rm_a_lights_level",
  "name": "Conference Room A Lights Level",
  "type": "analog",
  "access": "readwrite",
  "room": "Conference Room A",
  "category": "Lighting",
  "description": "Dimmer control for overhead lights",
  "current_value": "32767",
  "min_value": "0",
  "max_value": "65535",
  "unit": "level"
}
```

**Device Types:**
- `digital` - Boolean/binary (0 or 1)
- `analog` - Unsigned short (0-65535)
- `serial` - Text string
- `string` - Text string

**Access Modes:**
- `readonly` - Can only query
- `writeonly` - Can only set
- `readwrite` - Can query and set

---

### 5. QUERY
**Purpose:** Get current state of one or more devices  
**Format:** 
- `QUERY:device_id` - Single device
- `QUERY:device_id1,device_id2,...` - Multiple devices (comma-separated)

**Response (single device):**
```
OK:device_id:value
```

**Response (multiple devices):**
```
DATA:[{"id":"device_id1","value":"1"},{"id":"device_id2","value":"32767"}]
```

**Examples:**
```
Client: QUERY:conf_rm_a_lights_on
Server: OK:conf_rm_a_lights_on:1

Client: QUERY:conf_rm_a_lights_on,conf_rm_a_lights_level
Server: DATA:[{"id":"conf_rm_a_lights_on","value":"1"},{"id":"conf_rm_a_lights_level","value":"32767"}]
```

---

### 5a. STATE
**Purpose:** Get the live state of one device (value + in-flight / pending activity)  
**Format:** `STATE:device_id`

A richer single-device read than `QUERY`: the current value plus whether the device is **idle**,
**ramping** (analog: `target` + `completes_at`), or **pulsing** (digital: `releases_at`), and any
**pending** scheduled action (a delayed `SET_AFTER`/`PULSE`: `action`, `value`, `fires_at`). All
`*_at` fields are **epoch milliseconds** (see `TIME`); `remaining_ms` / `in_ms` give the time left
directly so a client can decide how long to wait without correlating a clock. `value` is omitted
for a write-only device; `pending` is omitted when nothing is scheduled.

**Response:**
```
DATA:{json}
```

**Examples:**
```
Client: STATE:lounge_a3
Server: DATA:{"device_id":"lounge_a3","value":"13020","type":"analog","state":"ramping","target":"60000","completes_at":1718671410000,"remaining_ms":4200}

Client: STATE:lounge_d8
Server: DATA:{"device_id":"lounge_d8","value":"1","type":"digital","state":"pulsing","releases_at":1718671406380,"remaining_ms":380}

Client: STATE:porch_d1
Server: DATA:{"device_id":"porch_d1","value":"0","type":"digital","state":"idle","pending":{"action":"pulse","value":"500","fires_at":1718671413600,"in_ms":7600}}

Client: STATE:lounge_a3
Server: DATA:{"device_id":"lounge_a3","value":"13020","type":"analog","state":"idle"}
```

---

### 6. SET
**Purpose:** Set device value  
**Format:** `SET:device_id:value`

**Value Types:**
- Digital: `0` or `1`
- Analog: `0` to `65535`
- Serial/String: any text; may contain colons (the value is the last field), but not a raw newline

**Response:**
```
OK:device_id:value_set
```

**Examples:**
```
Client: SET:conf_rm_a_lights_on:1
Server: OK:conf_rm_a_lights_on:1

Client: SET:conf_rm_a_lights_level:49151
Server: OK:conf_rm_a_lights_level:49151

Client: SET:conf_rm_a_display_source:HDMI 1
Server: OK:conf_rm_a_display_source:HDMI 1
```

---

### 6b. SET_AFTER
**Purpose:** Set a device value after a delay (deferred set)  
**Format:** `SET_AFTER:device_id:delay_ms:value`

- Works for any device type. `value` is the **last field** (may contain colons); `delay_ms` is numeric.
- The processor validates the device + access immediately and returns `OK` right away; the
  actual set runs `delay_ms` milliseconds later (a value error at fire time is logged on the
  processor console, not returned).
- `delay_ms` of `0` is equivalent to a plain `SET`.

**Response:**
```
OK:device_id:value
```

**Example:**
```
Client: SET_AFTER:porch_light_on:30000:1
Server: OK:porch_light_on:1
```

---

### 6a. RAMP
**Purpose:** Smoothly ramp (fade) an analog device to a value over a duration  
**Format:** `RAMP:device_id:value:duration_ms[:delay_ms]`

- **Analog devices only.** Digital/serial return an error.
- `value` is the target `0`-`65535`; `duration_ms` is the ramp time in milliseconds.
- Optional `delay_ms` (default 0): start the fade after that wait. A delayed ramp occupies
  the device's pending-action slot (see Scheduling and supersede); the `OK` means it's scheduled.
- All fields are numeric, so the line is split positionally on every colon.
- The ramp runs on the processor (a timer steps the output from its last commanded
  value to the target); the `OK` response means the ramp has started (or is scheduled).
- A subsequent `SET`/`RAMP`/`CANCEL` on the same device cancels an in-progress or pending ramp.

**Response:**
```
OK:device_id:target_value
```

**Examples:**
```
Client: RAMP:conf_rm_a_lights_level:32767:3000
Server: OK:conf_rm_a_lights_level:32767

Client: RAMP:conf_rm_a_lights_on:1:1000
Server: ERROR:1001:Device 'conf_rm_a_lights_on' is not analog; only analog devices ramp
```

---

### 6c. PULSE
**Purpose:** Momentarily pulse a digital device (a simulated button press)  
**Format:** `PULSE:device_id:pulse_ms[:delay_ms]`

- **Digital devices only.** Analog/serial return an error.
- After an optional `delay_ms` (default 0) the processor drives the output **high**, holds it
  for `pulse_ms` milliseconds, then drives it **low**. All fields are numeric.
- Runs on the processor (a timer drives the high/low writes); the `OK` response means the
  pulse has been scheduled/started.
- A subsequent `SET` or `PULSE` on the same device cancels a pulse in progress.

**Response:**
```
OK:device_id:pulse_ms
```

**Examples:**
```
Client: PULSE:conf_rm_a_doorbell:500
Server: OK:conf_rm_a_doorbell:500

Client: PULSE:conf_rm_a_gate:1000:5000
Server: OK:conf_rm_a_gate:1000

Client: PULSE:conf_rm_a_lights_level:500
Server: ERROR:1001:Device 'conf_rm_a_lights_level' is not digital; only digital devices pulse
```

---

### 6d. CANCEL
**Purpose:** Stop activity on a device and clear its pending scheduled action  
**Format:** `CANCEL:device_id`

- Clears the device's pending scheduled action (a delayed `SET_AFTER` or delayed `PULSE`).
- **Digital:** if a pulse is in progress (line held high *by the pulse*), it is released to **off**.
  A line that is high from a plain `SET` (no pulse running) is left untouched.
- **Analog:** a ramp in progress is **stopped where it is** (the level is not snapped anywhere).
- Otherwise it changes nothing; it is safe to call when nothing is pending/running.

**Response:**
```
OK:device_id:cancelled
```

**Example:**
```
Client: CANCEL:conf_rm_a_lights_level
Server: OK:conf_rm_a_lights_level:cancelled
```

---

### Scheduling and supersede (SET_AFTER / PULSE / RAMP delay)

Each device has **one** pending scheduled-action slot (a delayed `SET_AFTER`, `PULSE`, or `RAMP`).
**Last command wins:** any new command on a device (an immediate `SET`/`PULSE`/`RAMP`/`BATCH_SET`, a
new delayed action, or a `CANCEL`) replaces/clears that device's pending action. Scheduling a future action does **not**
abort an action already executing right now (e.g. a pulse mid-press finishes, then a separately
scheduled action fires later); only immediate commands and `CANCEL` interrupt an in-flight action.
The slot is per **device id**, so the `_d` / `_a` / `_s` facets of one physical device are
independent.

---

### 7. GET_INFO
**Purpose:** Get detailed information about a specific device  
**Format:** `GET_INFO:device_id`

**Response:**
```
DATA:{"id":"conf_rm_a_lights_level","type":"analog","name":"Conference Room A Lights","room":"Conference Room A","category":"Lighting","access":"readwrite","current_value":"32767","min_value":"0","max_value":"65535"}
```

---

### 8. BATCH_SET
**Purpose:** Set multiple devices in one command  
**Format:** `BATCH_SET:device_id1:value1,device_id2:value2,...`

**Response:**
```
DATA:[{"id":"device_id1","success":true},{"id":"device_id2","success":true}]
```

**Example:**
```
Client: BATCH_SET:conf_rm_a_lights_on:1,conf_rm_a_lights_level:49151
Server: DATA:[{"id":"conf_rm_a_lights_on","success":true,"value":"1"},{"id":"conf_rm_a_lights_level","success":true,"value":"49151"}]
```

---

### 9. PING
**Purpose:** Keep-alive / connectivity check  
**Format:** `PING`

**Response:**
```
OK:PONG
```

---

### 10. TIME
**Purpose:** Get the processor's current time in a machine-friendly form  
**Format:** `TIME`

Reads the processor's own clock. `epoch_ms` is UTC epoch milliseconds (use it to correlate the
`*_at` fields from `STATE`); `iso` is local ISO 8601 with offset for human legibility.

**Response:**
```
DATA:{"epoch_ms":1718671406000,"iso":"2026-06-18T12:43:26+10:00"}
```

---

## Error Responses

**Format:** `ERROR:code:message`

### Error Codes

| Code | Name | Description |
|------|------|-------------|
| 1000 | UNKNOWN_COMMAND | Command not recognized |
| 1001 | INVALID_PARAMETERS | Wrong number or format of parameters |
| 1002 | DEVICE_NOT_FOUND | Device ID does not exist |
| 1003 | ACCESS_DENIED | Device is read-only or write-only |
| 1004 | VALUE_OUT_OF_RANGE | Value exceeds device limits |
| 1005 | DEVICE_OFFLINE | Device is not responding |
| 1006 | INTERNAL_ERROR | Server-side error |
| 1007 | PARSE_ERROR | Could not parse command |
| 1008 | TIMEOUT | Command execution timeout |
| 1009 | AUTH_REQUIRED | Authentication required before this command |
| 1010 | AUTH_FAILED | Authentication credential rejected |
| 1011 | LICENSE_REQUIRED | Processor not licensed; activate it before this command |
| 1012 | LICENSE_INVALID | License rejected (bad signature, wrong MAC, malformed, or expired) |

**Examples:**
```
ERROR:1002:Device 'invalid_device' not found
ERROR:1003:Device 'temp_sensor' is read-only
ERROR:1004:Value 70000 out of range (0-65535) for device 'lights'
```

---

## Connection Lifecycle

### 1. Client Connects
```
[TCP connection established]
```

### 2. Handshake
```
Client: HELLO
Server: OK:MCP-CRESTRON:1.0:PROC-CP4-01
```

### 3. Discovery (optional)
```
Client: DISCOVER
Server: DATA:{...full system capabilities...}
```

### 4. Normal Operations
```
Client: QUERY:conf_rm_a_lights_on
Server: OK:conf_rm_a_lights_on:1

Client: SET:conf_rm_a_lights_level:49151
Server: OK:conf_rm_a_lights_level:49151
```

### 5. Disconnect
```
[TCP connection closed by either party]
```

---

## Best Practices

### For Crestron Implementation
- Validate all incoming commands before execution
- Return errors immediately for invalid requests
- Use thread-safe device registry
- Implement command timeouts (5 seconds default)
- Log all SET commands for audit trail

### For MCP Client Implementation
- Send HELLO immediately after connection
- Cache DISCOVER results to minimize queries
- Implement reconnection logic with exponential backoff
- Use PING for keep-alive (every 30 seconds)
- Handle ERROR responses gracefully

### Performance
- Batch queries when possible (QUERY with multiple devices)
- Batch sets for scene activation (BATCH_SET)
- Keep device IDs short but descriptive
- Limit LIST_DEVICES queries (cache results)

---

## Future Extensions (v2.0)

Potential additions for future versions:
- `SUBSCRIBE:device_id` - Real-time change notifications
- `UNSUBSCRIBE:device_id` - Stop notifications
- `EVENT:device_id:old_value:new_value` - Push notifications
- `AUTH:username:password` - Authentication
- `MACRO:macro_name` - Execute predefined macros
- `HISTORY:device_id:duration` - Get device value history

---

## Security Considerations

**v1.0 Security Model:**
- No built-in authentication (assumes secure local network)
- Access control enforced at device level (readonly/writeonly)
- Command validation prevents malformed requests
- Rate limiting recommended at firewall/network level

**Recommendations:**
- Run on isolated control network
- Use firewall to restrict access to MCP port
- Consider VPN for remote access
- Implement authentication in v2.0

---

## Version History

- **v1.0** - Initial specification
