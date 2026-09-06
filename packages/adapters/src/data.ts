import type { ModuleAdapter } from "@rackmcp/schemas";

/**
 * Verified ModuleAdapter documents (spec section 3.4). Authored and
 * adversarially verified against live `inspect_model` ground truth from
 * VCV Rack 2.6.6 (Core) and Fundamental 2.6.4; every paramId/portId and count
 * is cross-checked against captured metadata by the adapters unit test.
 *
 * GENERATED CONTENT, HAND-CURATED SEMANTICS. Regenerate counts/ids only from
 * fresh `inspect_model` output; never invent ports or parameters.
 */
export const ADAPTER_DOCS: ReadonlyArray<ModuleAdapter> = [
  {
    "adapterVersion": 1,
    "pluginSlug": "Core",
    "modelSlug": "AudioInterface2",
    "pluginVersionRange": ">=2.6.0 <3.0.0",
    "displayName": "Audio 2",
    "summary": "Core Audio 2 is VCV Rack's two-channel audio interface bridge to the host sound device. Its two inputs send patch audio to the device's outputs (speakers or DAW), scaled by a master Level knob, while its two outputs bring the device's inputs (microphone or line-in) back into the patch. In a subtractive synth patch it is normally the final output sink: the mix/VCA bus is patched into its inputs so the sound can be heard.",
    "params": [
      {
        "paramId": 0,
        "role": "level",
        "description": "Master output gain applied to both device-output channels. 0 mutes, 1 is unity gain, and 2 is roughly a +6 dB boost that can clip the interface.",
        "safeInitial": 1,
        "safeRange": [
          0,
          1
        ]
      }
    ],
    "inputs": [
      {
        "portId": 0,
        "role": "audio",
        "key": "audio_in_1",
        "description": "Audio sent to hardware device output channel 1 (e.g. left speaker / DAW input 1). Patch the final mix or VCA output here. Named \"To device output 1\".",
        "polyphony": "monophonic"
      },
      {
        "portId": 1,
        "role": "audio",
        "key": "audio_in_2",
        "description": "Audio sent to hardware device output channel 2 (e.g. right speaker / DAW input 2). Named \"To device output 2\".",
        "polyphony": "monophonic"
      }
    ],
    "outputs": [
      {
        "portId": 0,
        "role": "audio",
        "key": "audio_out_1",
        "description": "Audio received from hardware device input channel 1 (e.g. microphone or line-in left). Named \"From device input 1\".",
        "polyphony": "monophonic"
      },
      {
        "portId": 1,
        "role": "audio",
        "key": "audio_out_2",
        "description": "Audio received from hardware device input channel 2 (e.g. line-in right). Named \"From device input 2\".",
        "polyphony": "monophonic"
      }
    ],
    "polyphony": "monophonic",
    "opaqueStateFields": [],
    "validationRules": [],
    "connectionRecipes": [
      {
        "name": "Live input into processing",
        "description": "Route the hardware device input (channel 1) into a filter, VCA, or effect audio input to process an external source inside the patch.",
        "fromOutputKey": "audio_out_1",
        "toRole": "audio"
      },
      {
        "name": "Second live input channel",
        "description": "Route the hardware device input (channel 2) into another audio input for stereo or dual-source external processing.",
        "fromOutputKey": "audio_out_2",
        "toRole": "audio"
      }
    ],
    "provenance": [
      "inspect_model on VCV Rack 2.6.6 (Core) / Fundamental 2.6.4; port and parameter ids/names verified",
      "Semantics derived from verified Core Audio 2 param/port names and standard VCV Core AudioInterface behavior (inputs feed device outputs, outputs carry device inputs)."
    ]
  },
  {
    "adapterVersion": 1,
    "pluginSlug": "Core",
    "modelSlug": "AudioInterface",
    "pluginVersionRange": ">=2.6.0 <3.0.0",
    "displayName": "Audio 8",
    "summary": "Core audio interface bridging VCV Rack to the host sound card, exposing up to 8 device output channels and 8 device input channels. In a subtractive patch it is the final destination: the summed/processed synth signal is patched into its device-output inputs to reach speakers or a DAW, while its device-input outputs bring external audio (mic, line-in) into the rack for processing.",
    "params": [],
    "inputs": [
      {
        "portId": 0,
        "role": "audio",
        "key": "audio_in_1",
        "polyphony": "monophonic",
        "description": "Signal sent to device output channel 1 (to sound card / DAW)."
      },
      {
        "portId": 1,
        "role": "audio",
        "key": "audio_in_2",
        "polyphony": "monophonic",
        "description": "Signal sent to device output channel 2 (to sound card / DAW)."
      },
      {
        "portId": 2,
        "role": "audio",
        "key": "audio_in_3",
        "polyphony": "monophonic",
        "description": "Signal sent to device output channel 3."
      },
      {
        "portId": 3,
        "role": "audio",
        "key": "audio_in_4",
        "polyphony": "monophonic",
        "description": "Signal sent to device output channel 4."
      },
      {
        "portId": 4,
        "role": "audio",
        "key": "audio_in_5",
        "polyphony": "monophonic",
        "description": "Signal sent to device output channel 5."
      },
      {
        "portId": 5,
        "role": "audio",
        "key": "audio_in_6",
        "polyphony": "monophonic",
        "description": "Signal sent to device output channel 6."
      },
      {
        "portId": 6,
        "role": "audio",
        "key": "audio_in_7",
        "polyphony": "monophonic",
        "description": "Signal sent to device output channel 7."
      },
      {
        "portId": 7,
        "role": "audio",
        "key": "audio_in_8",
        "polyphony": "monophonic",
        "description": "Signal sent to device output channel 8."
      }
    ],
    "outputs": [
      {
        "portId": 0,
        "role": "audio",
        "key": "audio_out_1",
        "polyphony": "monophonic",
        "description": "Signal received from device input channel 1 (from sound card / DAW)."
      },
      {
        "portId": 1,
        "role": "audio",
        "key": "audio_out_2",
        "polyphony": "monophonic",
        "description": "Signal received from device input channel 2 (from sound card / DAW)."
      },
      {
        "portId": 2,
        "role": "audio",
        "key": "audio_out_3",
        "polyphony": "monophonic",
        "description": "Signal received from device input channel 3."
      },
      {
        "portId": 3,
        "role": "audio",
        "key": "audio_out_4",
        "polyphony": "monophonic",
        "description": "Signal received from device input channel 4."
      },
      {
        "portId": 4,
        "role": "audio",
        "key": "audio_out_5",
        "polyphony": "monophonic",
        "description": "Signal received from device input channel 5."
      },
      {
        "portId": 5,
        "role": "audio",
        "key": "audio_out_6",
        "polyphony": "monophonic",
        "description": "Signal received from device input channel 6."
      },
      {
        "portId": 6,
        "role": "audio",
        "key": "audio_out_7",
        "polyphony": "monophonic",
        "description": "Signal received from device input channel 7."
      },
      {
        "portId": 7,
        "role": "audio",
        "key": "audio_out_8",
        "polyphony": "monophonic",
        "description": "Signal received from device input channel 8."
      }
    ],
    "polyphony": "monophonic",
    "opaqueStateFields": [],
    "validationRules": [],
    "connectionRecipes": [
      {
        "name": "Device input into mixer/processing",
        "description": "Route external audio arriving from a device input channel into a mixer, VCA, or effect for processing inside the rack.",
        "fromOutputKey": "audio_out_1",
        "toRole": "audio"
      },
      {
        "name": "Stereo device input to processing",
        "description": "Bring in the second external input channel (e.g. right of a stereo pair) for processing or monitoring.",
        "fromOutputKey": "audio_out_2",
        "toRole": "audio"
      }
    ],
    "provenance": [
      "inspect_model on VCV Rack 2.6.6 (Core) / Fundamental 2.6.4; port and parameter ids/names verified",
      "Core AudioInterface (Audio 8) exposes no parameters; 8 inputs named 'To device output N' and 8 outputs named 'From device input N', all audio-rate, verified from ground-truth metadata"
    ]
  },
  {
    "adapterVersion": 1,
    "pluginSlug": "Core",
    "modelSlug": "MIDIToCVInterface",
    "pluginVersionRange": ">=2.6.0 <3.0.0",
    "displayName": "MIDI to CV",
    "summary": "Core MIDI-to-CV interface: converts incoming MIDI note, controller, and transport messages into control voltages, gates, and triggers. In a subtractive-synth patch it is the voice's front end, supplying 1V/octave pitch to a VCO, a gate to envelope generators, and velocity/aftertouch/wheel modulation plus clock and transport triggers for sequencing. It has no parameters or signal inputs; all configuration (MIDI device, channel, polyphony) lives in its context menu.",
    "params": [],
    "inputs": [],
    "outputs": [
      {
        "portId": 0,
        "role": "pitch_voct",
        "key": "pitch_out",
        "description": "1V/octave pitch CV derived from the played MIDI note number; patch to a VCO 1V/oct input to set oscillator pitch.",
        "polyphony": "polyphonic"
      },
      {
        "portId": 1,
        "role": "gate",
        "key": "gate_out",
        "description": "High (~10V) while a note is held, low on release; drives envelope generator gate inputs.",
        "polyphony": "polyphonic"
      },
      {
        "portId": 2,
        "role": "cv_unipolar",
        "key": "velocity_out",
        "description": "Unipolar note-on velocity CV (0-10V); commonly routed to a VCA or filter CV for velocity-sensitive dynamics.",
        "polyphony": "polyphonic"
      },
      {
        "portId": 3,
        "role": "cv_unipolar",
        "key": "aftertouch_out",
        "description": "Unipolar channel/poly aftertouch (pressure) CV (0-10V) for expressive modulation while a note is held.",
        "polyphony": "polyphonic"
      },
      {
        "portId": 4,
        "role": "cv_bipolar",
        "key": "pitch_wheel_out",
        "description": "Bipolar pitch-bend wheel CV (centered at 0V); typically summed into a VCO FM/pitch input for bend.",
        "polyphony": "monophonic"
      },
      {
        "portId": 5,
        "role": "cv_unipolar",
        "key": "mod_wheel_out",
        "description": "Unipolar mod-wheel (CC1) CV (0-10V); a general-purpose modulation source for cutoff, LFO depth, etc.",
        "polyphony": "monophonic"
      },
      {
        "portId": 6,
        "role": "trigger",
        "key": "retrigger_out",
        "description": "Emits a trigger pulse on each new note-on, including legato repeats, so envelopes can re-fire without the gate dropping.",
        "polyphony": "polyphonic"
      },
      {
        "portId": 7,
        "role": "clock",
        "key": "clock_out",
        "description": "MIDI clock pulses (24 PPQN) forwarded as a clock signal to drive sequencers, clock dividers, or synced LFOs.",
        "polyphony": "monophonic"
      },
      {
        "portId": 8,
        "role": "clock",
        "key": "clock_div_out",
        "description": "A divided version of the MIDI clock (division set in the context menu) for slower clock rates.",
        "polyphony": "monophonic"
      },
      {
        "portId": 9,
        "role": "trigger",
        "key": "start_out",
        "description": "Trigger pulse emitted when a MIDI Start transport message is received.",
        "polyphony": "monophonic"
      },
      {
        "portId": 10,
        "role": "trigger",
        "key": "stop_out",
        "description": "Trigger pulse emitted when a MIDI Stop transport message is received.",
        "polyphony": "monophonic"
      },
      {
        "portId": 11,
        "role": "trigger",
        "key": "continue_out",
        "description": "Trigger pulse emitted when a MIDI Continue transport message is received.",
        "polyphony": "monophonic"
      }
    ],
    "polyphony": "polyphonic",
    "opaqueStateFields": [],
    "validationRules": [],
    "connectionRecipes": [
      {
        "name": "Pitch to VCO",
        "description": "Patch the 1V/octave pitch output to a VCO's 1V/oct input so played MIDI notes set oscillator pitch.",
        "fromOutputKey": "pitch_out",
        "toRole": "pitch_voct"
      },
      {
        "name": "Gate to envelope",
        "description": "Patch the gate output to an ADSR/envelope generator gate input to open the voice while a key is held.",
        "fromOutputKey": "gate_out",
        "toRole": "gate"
      },
      {
        "name": "Velocity to VCA",
        "description": "Route the velocity output to a VCA (or filter) CV input for velocity-sensitive amplitude/timbre.",
        "fromOutputKey": "velocity_out",
        "toRole": "cv_unipolar"
      },
      {
        "name": "Clock to sequencer",
        "description": "Send the clock output to a sequencer or clocked module's clock input to sync it to MIDI tempo.",
        "fromOutputKey": "clock_out",
        "toRole": "clock"
      }
    ],
    "provenance": [
      "inspect_model on VCV Rack 2.6.6 (Core) MIDIToCVInterface; port ids/names verified against live metadata (12 outputs, no params, no inputs). Signal roles and semantics interpreted from output names and documented VCV Core MIDI-to-CV behavior.",
      "Adversarial verification against ground-truth metadata: all 12 output portIds (0-11) and names confirmed present; roles confirmed consistent with port names (portId 0 '1V/octave pitch' = pitch_voct, portId 4 'Pitch wheel' = cv_bipolar); no ports dropped; draft confirmed correct with no corrections needed."
    ]
  },
  {
    "adapterVersion": 1,
    "pluginSlug": "Fundamental",
    "modelSlug": "VCO",
    "pluginVersionRange": ">=2.6.0 <3.0.0",
    "displayName": "VCO",
    "summary": "Fundamental voltage-controlled oscillator. Tracks 1V/octave pitch and emits four simultaneous waveforms (sine, triangle, sawtooth, square/pulse), with FM, pulse-width control plus PWM, and a sync input. In a subtractive patch it is the primary tone source feeding a filter (VCF) and amplifier (VCA).",
    "params": [
      {
        "paramId": 0,
        "role": "unknown",
        "description": "Unnamed internal toggle (binary, range 0..1, default 0). Not surfaced with a label by the module; mapped only so validation can range-check it.",
        "safeInitial": 0
      },
      {
        "paramId": 1,
        "role": "sync_mode",
        "description": "Sync behavior selector for the Sync input. Snapped two-position switch: 0 = \"Soft\" sync, 1 = \"Hard\" sync. Ground-truth default is 1.",
        "safeInitial": 1
      },
      {
        "paramId": 2,
        "role": "frequency",
        "description": "Coarse pitch knob in semitones, summed with the 1V/oct pitch input. Range +/-54 semitones (+/-4.5 octaves); 0 = center pitch.",
        "safeInitial": 0
      },
      {
        "paramId": 3,
        "role": "unknown",
        "description": "Unnamed internal toggle (binary, range 0..1, default 0). Not surfaced with a label by the module; mapped only so validation can range-check it.",
        "safeInitial": 0
      },
      {
        "paramId": 4,
        "role": "fm_amount",
        "description": "Attenuverter for the Frequency modulation (FM) input. Bipolar (-1..1); negative values invert the modulation, 0 = no FM.",
        "safeInitial": 0
      },
      {
        "paramId": 5,
        "role": "pulse_width",
        "description": "Duty cycle of the square/pulse output. 0.5 = symmetric square; approaching the 0.01/0.99 extremes thins the pulse toward silence.",
        "safeInitial": 0.5,
        "safeRange": [
          0.1,
          0.9
        ]
      },
      {
        "paramId": 6,
        "role": "cv_attenuverter",
        "description": "Attenuverter for the Pulse width modulation (PWM) input. Bipolar (-1..1); 0 = no PWM.",
        "safeInitial": 0
      },
      {
        "paramId": 7,
        "role": "fm_mode",
        "description": "Frequency-modulation mode for the Frequency modulation CV input. Snapped two-position switch: 0 = \"1V/octave\", the CV is exponential and tracks pitch; 1 = \"Linear\", the CV modulates frequency linearly. Ground-truth default is 0. (Fundamental's Wavetable VCO -- modelSlug VCO2 -- names its own FM mode position 1 \"Through-zero linear\"; this VCO does not, so do not carry through-zero behaviour across from it.)",
        "safeInitial": 0
      }
    ],
    "inputs": [
      {
        "portId": 0,
        "role": "pitch_voct",
        "key": "pitch_in",
        "description": "1V/octave pitch input; summed with the Frequency knob to set oscillator pitch.",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 1,
        "role": "cv_bipolar",
        "key": "fm_in",
        "description": "Frequency modulation CV input, scaled by the Frequency modulation attenuverter (param 4). Bipolar audio/CV-rate modulation.",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 2,
        "role": "audio",
        "key": "sync_in",
        "description": "Sync (phase-reset) input; typically driven by an audio-rate oscillator output for hard/soft sync per the Sync mode switch (param 1).",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 3,
        "role": "cv_bipolar",
        "key": "pwm_in",
        "description": "Pulse width modulation CV input, scaled by the Pulse width modulation attenuverter (param 6). Modulates the square/pulse duty cycle.",
        "polyphony": "poly_from_input"
      }
    ],
    "outputs": [
      {
        "portId": 0,
        "role": "audio",
        "key": "sine_out",
        "description": "Sine wave audio output.",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 1,
        "role": "audio",
        "key": "tri_out",
        "description": "Triangle wave audio output.",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 2,
        "role": "audio",
        "key": "saw_out",
        "description": "Sawtooth wave audio output; harmonically rich, common source for subtractive patches.",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 3,
        "role": "audio",
        "key": "square_out",
        "description": "Square/pulse wave audio output; duty cycle set by Pulse width (param 5) and PWM input.",
        "polyphony": "poly_from_input"
      }
    ],
    "polyphony": "poly_from_input",
    "opaqueStateFields": [],
    "validationRules": [],
    "connectionRecipes": [
      {
        "name": "Sawtooth into filter",
        "description": "Patch the sawtooth output into a low-pass filter (VCF) audio input for classic subtractive synthesis.",
        "fromOutputKey": "saw_out",
        "toRole": "audio"
      },
      {
        "name": "Square with PWM into filter",
        "description": "Patch the square/pulse output (modulated via Pulse width / PWM) into a filter audio input for animated, hollow timbres.",
        "fromOutputKey": "square_out",
        "toRole": "audio"
      },
      {
        "name": "Sine to output or FM source",
        "description": "Route the pure sine output to an amplifier/audio output, or use it as a linear-FM modulator into another VCO's FM input.",
        "fromOutputKey": "sine_out",
        "toRole": "audio"
      },
      {
        "name": "Hard sync source",
        "description": "Patch this VCO's sawtooth into another VCO's Sync input to create hard-sync sweeping timbres.",
        "fromOutputKey": "saw_out",
        "toRole": "audio"
      }
    ],
    "provenance": [
      "inspect_model on VCV Rack 2.6.6 (Core) / Fundamental 2.6.4; parameter and port ids/names verified against live metadata",
      "Semantics defended from ground-truth param/port names and well-known VCV Fundamental VCO behavior; unnamed params 0 and 3 left as role 'unknown'",
      "Adversarial verification pass: all 8 paramIds and 4+4 portIds confirmed present in ground truth with matching ids; roles reconciled to port names; safeInitial/safeRange confirmed within ground-truth bounds"
    ]
  },
  {
    "adapterVersion": 1,
    "pluginSlug": "Fundamental",
    "modelSlug": "VCF",
    "pluginVersionRange": ">=2.6.0 <3.0.0",
    "displayName": "VCF",
    "summary": "VCF is Fundamental's voltage-controlled filter. It offers a resonant cutoff with a drive (saturation) stage and provides simultaneous low-pass and high-pass outputs from the same audio input. In a subtractive-synth voice it is the tone-shaping core: patch an oscillator into the Audio input and sweep cutoff and resonance (typically from an envelope or LFO) to carve the harmonic content.",
    "params": [
      {
        "paramId": 0,
        "role": "cutoff",
        "description": "Cutoff frequency knob (normalized 0..1 mapping to filter frequency). Center (default 0.5) sits in the audible mid-range; lower values darken the tone, higher values open it.",
        "safeInitial": 0.5
      },
      {
        "paramId": 1,
        "role": "unknown",
        "description": "Unnamed parameter exposed by the module with no verified semantics; likely internal/vestigial. Included so validation can range-check it against [0,1].",
        "safeInitial": 0
      },
      {
        "paramId": 2,
        "role": "resonance",
        "description": "Resonance (emphasis at the cutoff). Increasing this emphasizes frequencies near cutoff; very high settings approach self-oscillation.",
        "safeInitial": 0,
        "safeRange": [
          0,
          0.9
        ]
      },
      {
        "paramId": 3,
        "role": "cv_attenuverter",
        "description": "Attenuverter for the Frequency (cutoff) CV input. Scales and inverts the amount of external modulation applied to cutoff; 0 = no external cutoff modulation.",
        "safeInitial": 0
      },
      {
        "paramId": 4,
        "role": "drive",
        "description": "Drive amount, adding gain/saturation into the filter core. 0 = clean; positive values increase saturation and perceived loudness, negative values reduce drive.",
        "safeInitial": 0
      },
      {
        "paramId": 5,
        "role": "cv_attenuverter",
        "description": "Attenuverter for the Resonance CV input. Scales and inverts external modulation of resonance; 0 = no external resonance modulation.",
        "safeInitial": 0
      },
      {
        "paramId": 6,
        "role": "cv_attenuverter",
        "description": "Attenuverter for the Drive CV input. Scales and inverts external modulation of drive; 0 = no external drive modulation.",
        "safeInitial": 0
      }
    ],
    "inputs": [
      {
        "portId": 0,
        "role": "cv_bipolar",
        "key": "cutoff_cv",
        "description": "Cutoff frequency modulation input, summed with the Cutoff knob after scaling by the Cutoff frequency CV attenuverter (param 3). Accepts bipolar CV such as an envelope or LFO.",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 1,
        "role": "cv_bipolar",
        "key": "resonance_cv",
        "description": "Resonance modulation input, scaled by the Resonance CV attenuverter (param 5). Accepts bipolar CV.",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 2,
        "role": "cv_bipolar",
        "key": "drive_cv",
        "description": "Drive modulation input, scaled by the Drive CV attenuverter (param 6). Accepts bipolar CV.",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 3,
        "role": "audio",
        "key": "audio_in",
        "description": "Audio signal input to be filtered (e.g. an oscillator's output in a subtractive-synth voice).",
        "polyphony": "poly_from_input"
      }
    ],
    "outputs": [
      {
        "portId": 0,
        "role": "audio",
        "key": "lowpass_out",
        "description": "Low-pass filtered audio output: passes frequencies below cutoff, attenuates those above. The primary output for classic subtractive tones.",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 1,
        "role": "audio",
        "key": "highpass_out",
        "description": "High-pass filtered audio output: passes frequencies above cutoff, attenuates those below.",
        "polyphony": "poly_from_input"
      }
    ],
    "polyphony": "poly_from_input",
    "opaqueStateFields": [],
    "validationRules": [],
    "connectionRecipes": [
      {
        "name": "Low-pass output into a VCA",
        "description": "Patch the low-pass output into a VCA (or Audio module) audio input to hear the filtered voice; the classic subtractive-synth signal path.",
        "fromOutputKey": "lowpass_out",
        "toRole": "audio"
      },
      {
        "name": "High-pass output into audio path",
        "description": "Route the high-pass output into a downstream audio input (VCA, mixer, or Audio module) when you want to remove low-frequency content.",
        "fromOutputKey": "highpass_out",
        "toRole": "audio"
      },
      {
        "name": "Low-pass output into another filter/effect",
        "description": "Feed the low-pass output into another module's audio input for series filtering or effects processing.",
        "fromOutputKey": "lowpass_out",
        "toRole": "audio"
      }
    ],
    "provenance": [
      "inspect_model on VCV Rack 2.6.6 (Core) / Fundamental 2.6.4; param and port ids/names verified from live metadata",
      "Semantics derived from parameter/port names and standard VCV Fundamental VCF behavior (resonant multi-output filter with drive stage and CV attenuverters)",
      "Adversarial verification against ground-truth model metadata: all 7 paramIds (0-6), 4 inputs (0-3), 2 outputs (0-1) confirmed present with matching ids; roles, safeInitial and safeRange values confirmed within [min,max]"
    ]
  },
  {
    "adapterVersion": 1,
    "pluginSlug": "Fundamental",
    "modelSlug": "VCA-1",
    "pluginVersionRange": ">=2.6.0 <3.0.0",
    "displayName": "VCA",
    "summary": "A single-channel voltage-controlled amplifier that scales the amplitude of its audio/signal input by the Level knob multiplied by the CV input. In a subtractive-synth voice it is the dynamics stage: patch an envelope (e.g. an ADSR) into its CV input to shape a note's loudness contour, or use it to attenuate/gate any signal or modulation source.",
    "params": [
      {
        "paramId": 0,
        "role": "level",
        "description": "Manual gain/attenuation of the channel. Acts as the base amplitude and scales the CV input's effect; at 1 the VCA passes unity gain, at 0 it fully mutes.",
        "safeInitial": 1
      },
      {
        "paramId": 1,
        "role": "response_mode",
        "description": "Selects the VCA's amplitude response curve for the CV/Level. Snapped two-position switch: 0 = \"Exponential\", a natural, perceptually smooth taper; 1 = \"Linear\", direct proportional gain. Ground-truth default is 1, so set this to 0 if an envelope should taper exponentially.",
        "safeInitial": 1
      }
    ],
    "inputs": [
      {
        "portId": 0,
        "role": "cv_unipolar",
        "key": "gain_cv",
        "description": "Gain control voltage. Expected unipolar (0-10V); multiplies the signal amplitude together with the Level knob. Typically driven by an envelope or LFO.",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 1,
        "role": "audio",
        "key": "audio_in",
        "description": "Signal/audio input to be amplified or attenuated. Also usable to scale CV/modulation signals.",
        "polyphony": "poly_from_input"
      }
    ],
    "outputs": [
      {
        "portId": 0,
        "role": "audio",
        "key": "audio_out",
        "description": "Amplitude-scaled output of the input signal after the Level knob and gain CV are applied.",
        "polyphony": "poly_from_input"
      }
    ],
    "polyphony": "poly_from_input",
    "opaqueStateFields": [],
    "validationRules": [],
    "connectionRecipes": [
      {
        "name": "VCA to output or mixer",
        "description": "Send the amplitude-shaped signal to an audio output module, mixer channel, or the next stage of the voice.",
        "fromOutputKey": "audio_out",
        "toRole": "audio"
      },
      {
        "name": "VCA into filter",
        "description": "Feed the VCA output into a filter's audio input when placing amplitude control ahead of tone shaping in a subtractive voice.",
        "fromOutputKey": "audio_out",
        "toRole": "audio"
      }
    ],
    "provenance": [
      "inspect_model on VCV Rack 2.6.6 (Core) / Fundamental 2.6.4; port and parameter ids/names verified",
      "Semantics derived from Fundamental VCA-1 param/port names (Level, Response mode, CV, Channel) and documented Fundamental VCA-1 behavior",
      "Adversarial verification against ground truth: all paramIds (0,1), input portIds (0,1), output portId (0) confirmed present with matching names; signal roles confirmed consistent with port semantics"
    ]
  },
  {
    "adapterVersion": 1,
    "pluginSlug": "Fundamental",
    "modelSlug": "VCA",
    "pluginVersionRange": ">=2.6.0 <3.0.0",
    "displayName": "VCA-2",
    "summary": "VCA-2 is a dual voltage-controlled amplifier. Each of its two independent channels multiplies an incoming audio (or CV) signal by a manual level knob combined with an exponential and a linear CV gain input. In a subtractive synth it is the classic amplitude/gain stage where an envelope (patched into a CV input) shapes the loudness of an oscillator or filter output; each channel can also serve as a general-purpose signal attenuator or CV VCA.",
    "params": [
      {
        "paramId": 0,
        "role": "level",
        "description": "Channel 1 manual level (gain). 0 = silent, 1 = unity gain. Multiplies with the channel's CV inputs.",
        "safeInitial": 1,
        "safeRange": [
          0,
          1
        ]
      },
      {
        "paramId": 1,
        "role": "level",
        "description": "Channel 2 manual level (gain). 0 = silent, 1 = unity gain. Multiplies with the channel's CV inputs.",
        "safeInitial": 1,
        "safeRange": [
          0,
          1
        ]
      }
    ],
    "inputs": [
      {
        "portId": 0,
        "role": "cv_unipolar",
        "key": "ch1_exp_cv",
        "description": "Channel 1 exponential CV: unipolar control input that scales channel 1 gain with an exponential response.",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 1,
        "role": "cv_unipolar",
        "key": "ch1_lin_cv",
        "description": "Channel 1 linear CV: unipolar control input that scales channel 1 gain linearly.",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 2,
        "role": "audio",
        "key": "ch1_audio_in",
        "description": "Channel 1 signal input. Typically audio, but any signal to be amplitude-controlled.",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 3,
        "role": "cv_unipolar",
        "key": "ch2_exp_cv",
        "description": "Channel 2 exponential CV: unipolar control input that scales channel 2 gain with an exponential response.",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 4,
        "role": "cv_unipolar",
        "key": "ch2_lin_cv",
        "description": "Channel 2 linear CV: unipolar control input that scales channel 2 gain linearly.",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 5,
        "role": "audio",
        "key": "ch2_audio_in",
        "description": "Channel 2 signal input. Typically audio, but any signal to be amplitude-controlled.",
        "polyphony": "poly_from_input"
      }
    ],
    "outputs": [
      {
        "portId": 0,
        "role": "audio",
        "key": "ch1_audio_out",
        "description": "Channel 1 amplified output (input scaled by level knob and CV inputs).",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 1,
        "role": "audio",
        "key": "ch2_audio_out",
        "description": "Channel 2 amplified output (input scaled by level knob and CV inputs).",
        "polyphony": "poly_from_input"
      }
    ],
    "polyphony": "poly_from_input",
    "opaqueStateFields": [],
    "validationRules": [],
    "connectionRecipes": [
      {
        "name": "VCA channel 1 to mixer/output",
        "description": "Patch channel 1's amplified output into a mixer channel or the audio interface as the final gain stage of a voice.",
        "fromOutputKey": "ch1_audio_out",
        "toRole": "audio"
      },
      {
        "name": "VCA channel 2 to mixer/output",
        "description": "Patch channel 2's amplified output into a mixer channel or the audio interface as the final gain stage of a second voice.",
        "fromOutputKey": "ch2_audio_out",
        "toRole": "audio"
      },
      {
        "name": "VCA output as CV VCA",
        "description": "Use an amplified channel output as an attenuated/enveloped control signal feeding another module's CV input (e.g. gating an LFO or modulation source).",
        "fromOutputKey": "ch1_audio_out",
        "toRole": "cv_bipolar"
      }
    ],
    "provenance": [
      "inspect_model on VCV Rack 2.6.6 (Core) / Fundamental 2.6.4; port and parameter ids/names verified",
      "Semantics inferred from verified VCV Fundamental VCA-2 parameter/port names and well-known dual-VCA behavior",
      "Adversarial verification against ground-truth Fundamental/VCA schema: all paramIds (0-1), inputs (0-5), outputs (0-1) confirmed present with matching ids; roles confirmed against port names; safeInitial/safeRange within [0,1]"
    ]
  },
  {
    "adapterVersion": 1,
    "pluginSlug": "Fundamental",
    "modelSlug": "ADSR",
    "pluginVersionRange": ">=2.6.0 <3.0.0",
    "displayName": "ADSR EG",
    "summary": "Four-stage ADSR envelope generator producing a 0-10V unipolar envelope from a gate input; primary contour source for VCA amplitude and VCF cutoff in a subtractive voice.",
    "polyphony": "poly_from_input",
    "params": [
      {
        "paramId": 0,
        "role": "attack",
        "description": "Attack time knob: how long the envelope takes to rise from 0 to full after the gate opens. 0 = near-instant, 1 = longest attack.",
        "safeInitial": 0.5,
        "safeRange": [
          0,
          1
        ]
      },
      {
        "paramId": 1,
        "role": "decay",
        "description": "Decay time knob: how long the envelope takes to fall from the peak down to the sustain level. 0 = near-instant, 1 = longest decay.",
        "safeInitial": 0.5,
        "safeRange": [
          0,
          1
        ]
      },
      {
        "paramId": 2,
        "role": "sustain",
        "description": "Sustain level knob: the held level while the gate remains high, as a fraction of full scale. 0 = silent hold, 1 = full level.",
        "safeInitial": 0.5,
        "safeRange": [
          0,
          1
        ]
      },
      {
        "paramId": 3,
        "role": "release",
        "description": "Release time knob: how long the envelope takes to fall to 0 after the gate closes. 0 = near-instant, 1 = longest release.",
        "safeInitial": 0.5,
        "safeRange": [
          0,
          1
        ]
      },
      {
        "paramId": 4,
        "role": "cv_attenuverter",
        "description": "Attenuverter for the Attack CV input: scales and can invert the voltage at the Attack input (-1 fully inverts, 0 no modulation, +1 full positive).",
        "safeInitial": 0,
        "safeRange": [
          -1,
          1
        ]
      },
      {
        "paramId": 5,
        "role": "cv_attenuverter",
        "description": "Attenuverter for the Decay CV input: scales and can invert the voltage at the Decay input (-1 fully inverts, 0 no modulation, +1 full positive).",
        "safeInitial": 0,
        "safeRange": [
          -1,
          1
        ]
      },
      {
        "paramId": 6,
        "role": "cv_attenuverter",
        "description": "Attenuverter for the Sustain CV input: scales and can invert the voltage at the Sustain input (-1 fully inverts, 0 no modulation, +1 full positive).",
        "safeInitial": 0,
        "safeRange": [
          -1,
          1
        ]
      },
      {
        "paramId": 7,
        "role": "cv_attenuverter",
        "description": "Attenuverter for the Release CV input: scales and can invert the voltage at the Release input (-1 fully inverts, 0 no modulation, +1 full positive).",
        "safeInitial": 0,
        "safeRange": [
          -1,
          1
        ]
      },
      {
        "paramId": 8,
        "role": "manual_gate",
        "description": "Momentary Push button that manually opens the envelope's gate, letting the envelope be triggered by hand with no cable patched into the Gate input. 0 = released, 1 = pressed.",
        "safeInitial": 0,
        "safeRange": [
          0,
          1
        ]
      }
    ],
    "inputs": [
      {
        "portId": 0,
        "role": "cv_bipolar",
        "key": "attack_cv",
        "description": "Attack-time modulation CV, summed with the Attack knob after passing through the Attack CV attenuverter.",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 1,
        "role": "cv_bipolar",
        "key": "decay_cv",
        "description": "Decay-time modulation CV, summed with the Decay knob after passing through the Decay CV attenuverter.",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 2,
        "role": "cv_bipolar",
        "key": "sustain_cv",
        "description": "Sustain-level modulation CV, summed with the Sustain knob after passing through the Sustain CV attenuverter.",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 3,
        "role": "cv_bipolar",
        "key": "release_cv",
        "description": "Release-time modulation CV, summed with the Release knob after passing through the Release CV attenuverter.",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 4,
        "role": "gate",
        "key": "gate_in",
        "description": "Gate input. A high gate opens the envelope (Attack -> Decay -> Sustain); gate-off starts the Release stage. Its channel count sets the module's polyphony.",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 5,
        "role": "trigger",
        "key": "retrig_in",
        "description": "Retrigger input. A trigger restarts the envelope from the Attack stage while the gate is still held.",
        "polyphony": "poly_from_input"
      }
    ],
    "outputs": [
      {
        "portId": 0,
        "role": "cv_unipolar",
        "key": "env_out",
        "description": "Envelope output: a 0-10V unipolar control voltage following the ADSR contour, used to modulate VCA amplitude, VCF cutoff or any other CV-controllable parameter.",
        "polyphony": "poly_from_input"
      }
    ],
    "opaqueStateFields": [],
    "validationRules": [],
    "connectionRecipes": [
      {
        "name": "Amplitude envelope into VCA",
        "description": "Patch the Envelope output into a VCA's level/CV input so the envelope shapes note amplitude over time. This is the canonical last stage of a subtractive synth voice.",
        "fromOutputKey": "env_out",
        "toRole": "cv_unipolar"
      },
      {
        "name": "Filter envelope into VCF cutoff",
        "description": "Patch the Envelope output into a filter's cutoff CV input to sweep the cutoff frequency with the envelope for classic filter-envelope movement.",
        "fromOutputKey": "env_out",
        "toRole": "cv_unipolar"
      },
      {
        "name": "General-purpose modulation source",
        "description": "Use the 0-10V envelope as a modulation source into any bipolar-accepting CV input (e.g. VCO FM, wavefolder, or an attenuverter) to add a per-note contour.",
        "fromOutputKey": "env_out",
        "toRole": "cv_bipolar"
      }
    ],
    "provenance": [
      "inspect_model on VCV Rack 2.6.6 (Core) / Fundamental 2.6.4; all param and port ids/names verified against live module metadata",
      "Semantics defended from parameter/port names and well-known VCV Fundamental ADSR EG behavior (poly_from_input; per-stage CV inputs routed through bipolar attenuverters; 0-10V unipolar envelope output)",
      "Adversarial verification against ground-truth metadata: all 9 paramIds (0-8), 6 input portIds (0-5), and 1 output portId (0) confirmed present with matching ids/names; roles, safeInitials, and safeRanges validated against declared [min,max]"
    ]
  },
  {
    "adapterVersion": 1,
    "pluginSlug": "Fundamental",
    "modelSlug": "LFO",
    "pluginVersionRange": ">=2.6.0 <3.0.0",
    "displayName": "LFO",
    "summary": "Low-frequency oscillator from VCV Fundamental. Simultaneously outputs sine, triangle, sawtooth, and square waveforms intended as modulation sources in a subtractive-synth patch — sweeping filter cutoff, adding pitch vibrato, or driving VCA level for tremolo. Frequency and pulse width each have a dedicated CV input and a bipolar attenuverter, plus Clock and Reset inputs for sync and Offset/Invert switches that shape output polarity. The Offset switch defaults to Unipolar, so the four waveform outputs swing approx. 0..10 V until it is switched.",
    "polyphony": "poly_from_input",
    "params": [
      {
        "paramId": 0,
        "role": "offset",
        "description": "Offset toggle. Snapped two-position switch: 0 = \"Bipolar\", waveform outputs swing approx. +/-5 V; 1 = \"Unipolar\", approx. 0..10 V. Ground-truth default is 1, so a freshly added LFO modulates positive-only unless this is switched to 0.",
        "safeInitial": 1
      },
      {
        "paramId": 1,
        "role": "invert",
        "description": "Invert toggle. Snapped two-position switch flipping the polarity of the waveform outputs; Rack renders no name for either position. Ground-truth default is 0.",
        "safeInitial": 0
      },
      {
        "paramId": 2,
        "role": "frequency",
        "description": "Main LFO rate knob in exponential (octave-like) units, range -8..10. Sets the oscillation frequency; lower values are slow modulation, high values push toward audio rate. Ground-truth default 1.",
        "safeInitial": 1,
        "safeRange": [
          -4,
          6
        ]
      },
      {
        "paramId": 3,
        "role": "fm_amount",
        "description": "Frequency-modulation attenuverter (bipolar, -1..1) scaling the signal at the Frequency modulation CV input. 0 = no FM; negative values invert the modulation. Ground-truth default 0.",
        "safeInitial": 0
      },
      {
        "paramId": 4,
        "role": "unknown",
        "description": "Unnamed parameter reported by inspect_model (range 0..1, default 0). No panel name was returned; semantics not verified, so left unknown but included for range validation.",
        "safeInitial": 0
      },
      {
        "paramId": 5,
        "role": "pulse_width",
        "description": "Pulse width of the square output, range 0.01..0.99 (fraction of the cycle). 0.5 = symmetric square. Ground-truth default 0.5.",
        "safeInitial": 0.5,
        "safeRange": [
          0.1,
          0.9
        ]
      },
      {
        "paramId": 6,
        "role": "pwm_amount",
        "description": "Pulse-width-modulation attenuverter (bipolar, -1..1) scaling the signal at the Pulse width modulation CV input. 0 = no PWM; negative values invert the modulation. Ground-truth default 0.",
        "safeInitial": 0
      }
    ],
    "inputs": [
      {
        "portId": 0,
        "role": "cv_bipolar",
        "key": "fm_cv",
        "description": "Frequency modulation CV input. Bipolar CV summed into the LFO rate, scaled by the FM attenuverter (paramId 3).",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 1,
        "role": "unknown",
        "key": "input_2",
        "description": "Input reported by inspect_model with placeholder name '#2'. No descriptive name was returned; role not verified, so left unknown but included for validation.",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 2,
        "role": "trigger",
        "key": "reset_in",
        "description": "Reset input. A rising edge restarts the oscillator phase, allowing the LFO to be synced/retriggered.",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 3,
        "role": "cv_bipolar",
        "key": "pwm_cv",
        "description": "Pulse width modulation CV input. Bipolar CV added to the pulse width, scaled by the PWM attenuverter (paramId 6).",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 4,
        "role": "clock",
        "key": "clock_in",
        "description": "Clock input. External clock used to lock/sync the LFO rate.",
        "polyphony": "poly_from_input"
      }
    ],
    "outputs": [
      {
        "portId": 0,
        "role": "cv_unipolar",
        "key": "sine_out",
        "description": "Sine waveform output. Unipolar (approx. 0..10 V) at the default Offset position (paramId 0 = 1, \"Unipolar\"); set Offset to 0 for bipolar approx. +/-5 V.",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 1,
        "role": "cv_unipolar",
        "key": "triangle_out",
        "description": "Triangle waveform output. Unipolar (approx. 0..10 V) at the default Offset position; set Offset (paramId 0) to 0 for bipolar approx. +/-5 V.",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 2,
        "role": "cv_unipolar",
        "key": "sawtooth_out",
        "description": "Sawtooth (ramp) waveform output. Unipolar (approx. 0..10 V) at the default Offset position; set Offset (paramId 0) to 0 for bipolar approx. +/-5 V.",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 3,
        "role": "cv_unipolar",
        "key": "square_out",
        "description": "Square/pulse waveform output whose duty cycle is set by Pulse width (paramId 5). Unipolar (approx. 0..10 V) at the default Offset position, which is also what makes it usable directly as a gate/clock-like source; set Offset (paramId 0) to 0 for bipolar.",
        "polyphony": "poly_from_input"
      }
    ],
    "opaqueStateFields": [],
    "validationRules": [],
    "connectionRecipes": [
      {
        "name": "LFO to filter cutoff (wah/sweep)",
        "description": "Patch the sine output into a filter's cutoff CV input to slowly sweep the cutoff frequency for a wah or auto-sweep effect.",
        "fromOutputKey": "sine_out",
        "toRole": "cv_bipolar"
      },
      {
        "name": "LFO to VCA level (tremolo)",
        "description": "Patch the triangle output into a VCA's level/CV input to modulate amplitude for tremolo.",
        "fromOutputKey": "triangle_out",
        "toRole": "cv_bipolar"
      },
      {
        "name": "LFO to oscillator pitch (vibrato)",
        "description": "Patch the sawtooth or sine output (with a small attenuation) into a VCO's FM/pitch CV input for vibrato or ramp-style pitch modulation.",
        "fromOutputKey": "sawtooth_out",
        "toRole": "cv_bipolar"
      },
      {
        "name": "Square LFO as gate/clock",
        "description": "Patch the square output into a gate or clock input to drive rhythmic on/off events or trigger clocked modules.",
        "fromOutputKey": "square_out",
        "toRole": "gate"
      }
    ],
    "provenance": [
      "inspect_model on VCV Rack 2.6.6 (Core) / Fundamental 2.6.4; parameter and port ids, names, and ranges verified against live metadata.",
      "Signal roles and semantics inferred from Fundamental LFO parameter/port names and standard VCV Fundamental LFO behavior. Unnamed paramId 4 and placeholder-named input portId 1 ('#2') are left as role 'unknown' pending source verification. Waveform outputs were originally classified cv_bipolar on the assumption that an LFO modulation source is bipolar by default; captured ground truth contradicts that (paramId 0 'Offset' has defaultValue 1, displayValue 'Unipolar'), so they are classified cv_unipolar, matching the module as it arrives in a patch. Both roles are in the same coarse signal family, so this changes advice, not validation outcomes.",
      "Adversarial verification pass: every paramId (0-6), input portId (0-4), and output portId (0-3) confirmed present in ground truth with matching ids; all safeInitial values equal ground-truth defaults and lie within [min,max]; safeRange for Frequency [-4,6] and Pulse width [0.1,0.9] confirmed within bounds and musically sensible. Reset->trigger and Clock->clock role assignments match port names. No real ports dropped. Draft found correct; returned unchanged."
    ]
  },
  {
    "adapterVersion": 1,
    "pluginSlug": "Fundamental",
    "modelSlug": "VCMixer",
    "pluginVersionRange": ">=2.6.0 <3.0.0",
    "displayName": "VCA Mix",
    "summary": "Four-channel voltage-controlled mixer. Each of the four channel inputs passes through its own VCA whose gain is set by a channel level knob and optionally scaled by a unipolar channel CV input; the four channels are summed and scaled by a master Mix level (also CV-controllable) to the Mix output, and each channel has a direct output tapped post-VCA. In a subtractive-synth patch it balances and combines multiple audio or CV sources into a submix and provides voltage-controlled level automation of that mix.",
    "polyphony": "poly_from_input",
    "params": [
      {
        "paramId": 0,
        "role": "mix_level",
        "description": "Master mix output level (VCA gain on the summed signal). 0 = silence, 1 = unity, up to 2 = +6 dB makeup gain. The Mix CV input scales this level.",
        "safeInitial": 1,
        "safeRange": [
          0,
          2
        ]
      },
      {
        "paramId": 1,
        "role": "level",
        "description": "Channel 1 level (VCA gain). 0 = silent, 1 = unity, up to ~1.414 = +3 dB. Scaled by the Channel 1 CV input when patched.",
        "safeInitial": 1,
        "safeRange": [
          0,
          1.4142135381698608
        ]
      },
      {
        "paramId": 2,
        "role": "level",
        "description": "Channel 2 level (VCA gain). 0 = silent, 1 = unity, up to ~1.414 = +3 dB. Scaled by the Channel 2 CV input when patched.",
        "safeInitial": 1,
        "safeRange": [
          0,
          1.4142135381698608
        ]
      },
      {
        "paramId": 3,
        "role": "level",
        "description": "Channel 3 level (VCA gain). 0 = silent, 1 = unity, up to ~1.414 = +3 dB. Scaled by the Channel 3 CV input when patched.",
        "safeInitial": 1,
        "safeRange": [
          0,
          1.4142135381698608
        ]
      },
      {
        "paramId": 4,
        "role": "level",
        "description": "Channel 4 level (VCA gain). 0 = silent, 1 = unity, up to ~1.414 = +3 dB. Scaled by the Channel 4 CV input when patched.",
        "safeInitial": 1,
        "safeRange": [
          0,
          1.4142135381698608
        ]
      }
    ],
    "inputs": [
      {
        "portId": 0,
        "role": "cv_unipolar",
        "key": "mix_cv",
        "description": "Unipolar CV that scales the master Mix level, giving voltage control over the overall submix gain.",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 1,
        "role": "audio",
        "key": "ch1_in",
        "description": "Channel 1 signal input (audio or CV) fed into channel 1's VCA.",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 2,
        "role": "audio",
        "key": "ch2_in",
        "description": "Channel 2 signal input (audio or CV) fed into channel 2's VCA.",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 3,
        "role": "audio",
        "key": "ch3_in",
        "description": "Channel 3 signal input (audio or CV) fed into channel 3's VCA.",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 4,
        "role": "audio",
        "key": "ch4_in",
        "description": "Channel 4 signal input (audio or CV) fed into channel 4's VCA.",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 5,
        "role": "cv_unipolar",
        "key": "ch1_cv",
        "description": "Unipolar CV that scales channel 1's VCA gain, e.g. an envelope for amplitude modulation of channel 1.",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 6,
        "role": "cv_unipolar",
        "key": "ch2_cv",
        "description": "Unipolar CV that scales channel 2's VCA gain, e.g. an envelope for amplitude modulation of channel 2.",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 7,
        "role": "cv_unipolar",
        "key": "ch3_cv",
        "description": "Unipolar CV that scales channel 3's VCA gain, e.g. an envelope for amplitude modulation of channel 3.",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 8,
        "role": "cv_unipolar",
        "key": "ch4_cv",
        "description": "Unipolar CV that scales channel 4's VCA gain, e.g. an envelope for amplitude modulation of channel 4.",
        "polyphony": "poly_from_input"
      }
    ],
    "outputs": [
      {
        "portId": 0,
        "role": "audio",
        "key": "mix_out",
        "description": "Summed mix of all four channels after their VCAs, scaled by the master Mix level. Primary output of the module.",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 1,
        "role": "audio",
        "key": "ch1_out",
        "description": "Direct output of channel 1 tapped post-VCA (post level knob and channel CV), before the master mix sum.",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 2,
        "role": "audio",
        "key": "ch2_out",
        "description": "Direct output of channel 2 tapped post-VCA (post level knob and channel CV), before the master mix sum.",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 3,
        "role": "audio",
        "key": "ch3_out",
        "description": "Direct output of channel 3 tapped post-VCA (post level knob and channel CV), before the master mix sum.",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 4,
        "role": "audio",
        "key": "ch4_out",
        "description": "Direct output of channel 4 tapped post-VCA (post level knob and channel CV), before the master mix sum.",
        "polyphony": "poly_from_input"
      }
    ],
    "opaqueStateFields": [],
    "validationRules": [],
    "connectionRecipes": [
      {
        "name": "Mix to audio output",
        "description": "Patch the summed Mix output into an audio destination such as the Core Audio module, a filter (VCF) input, or a final VCA.",
        "fromOutputKey": "mix_out",
        "toRole": "audio"
      },
      {
        "name": "Channel direct out to effect chain",
        "description": "Use a per-channel direct output (post-VCA) to route one channel to its own effect chain or a separate submix instead of, or in addition to, the main Mix bus.",
        "fromOutputKey": "ch1_out",
        "toRole": "audio"
      }
    ],
    "provenance": [
      "inspect_model on VCV Rack 2.6.6 (Core) / Fundamental 2.6.4; all param and port ids/names verified against live metadata.",
      "Semantics derived from the verified parameter/port names and documented VCV Fundamental VCMixer (VCA Mix) behavior: per-channel VCAs with unipolar CV, summed mix scaled by a CV-controllable master level, plus per-channel direct outputs.",
      "Adversarial verification against ground-truth model metadata (Fundamental/VCMixer): all 5 param ids (0-4), 9 input ids (0-8), and 5 output ids (0-4) confirmed present with matching names; signal roles confirmed consistent with port names; safeInitial/safeRange confirmed within [min,max]. Draft required no corrections."
    ]
  },
  {
    "adapterVersion": 1,
    "pluginSlug": "Fundamental",
    "modelSlug": "Mixer",
    "pluginVersionRange": ">=2.6.0 <3.0.0",
    "displayName": "Mix",
    "summary": "Mix is a simple 6-channel summing mixer: it adds the six channel inputs together and scales the result with a single master Level knob before sending it to the Mix output. In a subtractive-synth patch it combines multiple voices, oscillator outputs, or modulation sources into one signal, and its Level knob doubles as a master attenuator on the summed output.",
    "params": [
      {
        "paramId": 0,
        "role": "level",
        "safeInitial": 1,
        "safeRange": [
          0,
          1
        ],
        "description": "Master level applied to the summed mix. 0 mutes the output, 1 passes the full sum (default). Acts as an overall attenuator on the combined signal."
      }
    ],
    "inputs": [
      {
        "portId": 0,
        "role": "audio",
        "key": "channel_1_in",
        "polyphony": "poly_from_input",
        "description": "Channel 1 signal input, summed into the mix. Typically an audio signal but any signal (including CV) can be summed here."
      },
      {
        "portId": 1,
        "role": "audio",
        "key": "channel_2_in",
        "polyphony": "poly_from_input",
        "description": "Channel 2 signal input, summed into the mix."
      },
      {
        "portId": 2,
        "role": "audio",
        "key": "channel_3_in",
        "polyphony": "poly_from_input",
        "description": "Channel 3 signal input, summed into the mix."
      },
      {
        "portId": 3,
        "role": "audio",
        "key": "channel_4_in",
        "polyphony": "poly_from_input",
        "description": "Channel 4 signal input, summed into the mix."
      },
      {
        "portId": 4,
        "role": "audio",
        "key": "channel_5_in",
        "polyphony": "poly_from_input",
        "description": "Channel 5 signal input, summed into the mix."
      },
      {
        "portId": 5,
        "role": "audio",
        "key": "channel_6_in",
        "polyphony": "poly_from_input",
        "description": "Channel 6 signal input, summed into the mix."
      }
    ],
    "outputs": [
      {
        "portId": 0,
        "role": "audio",
        "key": "mix_out",
        "polyphony": "poly_from_input",
        "description": "Summed output of all six channels scaled by the Level knob. Send to a VCA, filter, or an audio output module."
      }
    ],
    "polyphony": "poly_from_input",
    "opaqueStateFields": [],
    "validationRules": [],
    "connectionRecipes": [
      {
        "name": "Mix into audio output",
        "description": "Route the summed mix to a Core Audio output module (or interface) to hear the combined signal.",
        "fromOutputKey": "mix_out",
        "toRole": "audio"
      },
      {
        "name": "Mix into a VCA",
        "description": "Feed the mix into a VCA's audio input for overall level/envelope shaping of the combined voices.",
        "fromOutputKey": "mix_out",
        "toRole": "audio"
      },
      {
        "name": "Mix into a filter",
        "description": "Send the summed signal into a filter's audio input for shared subtractive tone shaping across all mixed sources.",
        "fromOutputKey": "mix_out",
        "toRole": "audio"
      }
    ],
    "provenance": [
      "inspect_model on VCV Rack 2.6.6 (Core) / Fundamental 2.6.4; port and parameter ids/names verified",
      "Semantics inferred from Fundamental Mix (6-channel summing mixer) param/port names: single Level knob scales the sum of Channel 1-6 inputs to the Mix output",
      "Adversarially verified against ground truth: paramId 0 (Level), inputs 0-5 (Channel 1-6), output 0 (Mix) all confirmed; roles, safeInitial/safeRange within [0,1] confirmed"
    ]
  },
  {
    "adapterVersion": 1,
    "pluginSlug": "Fundamental",
    "modelSlug": "Sum",
    "pluginVersionRange": ">=2.6.0 <3.0.0",
    "displayName": "Sum",
    "summary": "Sum collapses a polyphonic cable into a single monophonic output by adding the voltages of all of its channels, with a Level knob that attenuates the result. In a subtractive-synth patch it is typically used to mix the voices of a polyphonic oscillator or VCA stack down to one signal before further processing, or to combine several channels of polyphonic CV into a single control voltage.",
    "polyphony": "monophonic",
    "params": [
      {
        "paramId": 0,
        "role": "level",
        "description": "Output attenuation applied to the summed signal. 0 mutes the output; 1 (the default) passes the sum at unity gain. The full range only attenuates, so it never boosts beyond the summed input.",
        "safeInitial": 1,
        "safeRange": [
          0,
          1
        ]
      }
    ],
    "inputs": [
      {
        "portId": 0,
        "role": "audio",
        "key": "audio_in",
        "description": "Polyphonic input whose channel voltages are summed. Named \"Polyphonic\" in the module; accepts up to Rack's 16 channels and is most commonly fed a polyphonic audio signal, though it will sum any polyphonic signal presented to it.",
        "polyphony": "polyphonic"
      }
    ],
    "outputs": [
      {
        "portId": 0,
        "role": "audio",
        "key": "audio_out",
        "description": "Monophonic output carrying the sum of all channels of the input, scaled by the Level knob. Always a single channel regardless of the input channel count.",
        "polyphony": "monophonic"
      }
    ],
    "opaqueStateFields": [],
    "validationRules": [],
    "connectionRecipes": [
      {
        "name": "Summed voices to audio input",
        "description": "Patch the monophonic sum into an audio input such as a VCA, mixer channel, or the Audio output module to hear or further process the combined polyphonic voices as one signal.",
        "fromOutputKey": "audio_out",
        "toRole": "audio"
      },
      {
        "name": "Combined CV to a modulation input",
        "description": "When the input carries polyphonic CV, route the monophonic sum into a bipolar CV/modulation input (for example a filter cutoff or VCA CV) to drive it with the combined control voltage of all channels.",
        "fromOutputKey": "audio_out",
        "toRole": "cv_bipolar"
      }
    ],
    "provenance": [
      "inspect_model on VCV Rack 2.6.6 (Core) / Fundamental 2.6.4; port and parameter ids/names verified",
      "Semantics derived from ground-truth param name (Level, 0-1, default 1) and port names (input \"Polyphonic\", output \"Monophonic\") plus well-known VCV Fundamental Sum behavior (sums polyphonic channels to a monophonic output with a level trim)"
    ]
  },
  {
    "adapterVersion": 1,
    "pluginSlug": "Fundamental",
    "modelSlug": "Merge",
    "pluginVersionRange": ">=2.6.0 <3.0.0",
    "displayName": "Merge",
    "summary": "Merge combines up to 16 separate monophonic cables into a single polyphonic cable, assigning each connected input to one channel of the poly output. In a patch it is the counterpart to Split: use it to build a polyphonic voice from individual mono sources (e.g. gather several mono pitch, gate, or audio signals) so downstream polyphonic modules can process all channels through one connection.",
    "params": [],
    "inputs": [
      {
        "portId": 0,
        "role": "unknown",
        "key": "merge_ch1",
        "polyphony": "monophonic",
        "description": "Monophonic input routed to channel 1 of the polyphonic output. Signal type is agnostic (audio, pitch, gate, or CV)."
      },
      {
        "portId": 1,
        "role": "unknown",
        "key": "merge_ch2",
        "polyphony": "monophonic",
        "description": "Monophonic input routed to channel 2 of the polyphonic output."
      },
      {
        "portId": 2,
        "role": "unknown",
        "key": "merge_ch3",
        "polyphony": "monophonic",
        "description": "Monophonic input routed to channel 3 of the polyphonic output."
      },
      {
        "portId": 3,
        "role": "unknown",
        "key": "merge_ch4",
        "polyphony": "monophonic",
        "description": "Monophonic input routed to channel 4 of the polyphonic output."
      },
      {
        "portId": 4,
        "role": "unknown",
        "key": "merge_ch5",
        "polyphony": "monophonic",
        "description": "Monophonic input routed to channel 5 of the polyphonic output."
      },
      {
        "portId": 5,
        "role": "unknown",
        "key": "merge_ch6",
        "polyphony": "monophonic",
        "description": "Monophonic input routed to channel 6 of the polyphonic output."
      },
      {
        "portId": 6,
        "role": "unknown",
        "key": "merge_ch7",
        "polyphony": "monophonic",
        "description": "Monophonic input routed to channel 7 of the polyphonic output."
      },
      {
        "portId": 7,
        "role": "unknown",
        "key": "merge_ch8",
        "polyphony": "monophonic",
        "description": "Monophonic input routed to channel 8 of the polyphonic output."
      },
      {
        "portId": 8,
        "role": "unknown",
        "key": "merge_ch9",
        "polyphony": "monophonic",
        "description": "Monophonic input routed to channel 9 of the polyphonic output."
      },
      {
        "portId": 9,
        "role": "unknown",
        "key": "merge_ch10",
        "polyphony": "monophonic",
        "description": "Monophonic input routed to channel 10 of the polyphonic output."
      },
      {
        "portId": 10,
        "role": "unknown",
        "key": "merge_ch11",
        "polyphony": "monophonic",
        "description": "Monophonic input routed to channel 11 of the polyphonic output."
      },
      {
        "portId": 11,
        "role": "unknown",
        "key": "merge_ch12",
        "polyphony": "monophonic",
        "description": "Monophonic input routed to channel 12 of the polyphonic output."
      },
      {
        "portId": 12,
        "role": "unknown",
        "key": "merge_ch13",
        "polyphony": "monophonic",
        "description": "Monophonic input routed to channel 13 of the polyphonic output."
      },
      {
        "portId": 13,
        "role": "unknown",
        "key": "merge_ch14",
        "polyphony": "monophonic",
        "description": "Monophonic input routed to channel 14 of the polyphonic output."
      },
      {
        "portId": 14,
        "role": "unknown",
        "key": "merge_ch15",
        "polyphony": "monophonic",
        "description": "Monophonic input routed to channel 15 of the polyphonic output."
      },
      {
        "portId": 15,
        "role": "unknown",
        "key": "merge_ch16",
        "polyphony": "monophonic",
        "description": "Monophonic input routed to channel 16 of the polyphonic output."
      }
    ],
    "outputs": [
      {
        "portId": 0,
        "role": "unknown",
        "key": "poly_out",
        "polyphony": "polyphonic",
        "description": "Polyphonic output combining all connected inputs; each connected input occupies one channel. Channel count defaults to the highest connected input (or a fixed count set via the context menu). Signal type is agnostic (audio, pitch, gate, or CV)."
      }
    ],
    "polyphony": "polyphonic",
    "opaqueStateFields": [],
    "validationRules": [],
    "connectionRecipes": [
      {
        "name": "Poly voice into polyphonic audio input",
        "description": "Feed the merged polyphonic cable into a polyphonic audio input (e.g. a poly VCA or mixer channel) when the merged channels carry audio.",
        "fromOutputKey": "poly_out",
        "toRole": "audio"
      },
      {
        "name": "Poly pitch into polyphonic VCO",
        "description": "When the merged channels carry 1V/oct pitch signals, patch the poly output into a polyphonic VCO's V/oct input to drive multiple voices from one cable.",
        "fromOutputKey": "poly_out",
        "toRole": "pitch_voct"
      },
      {
        "name": "Poly gates into polyphonic envelope",
        "description": "When the merged channels carry gates, patch the poly output into a polyphonic ADSR/envelope gate input to trigger per-channel envelopes.",
        "fromOutputKey": "poly_out",
        "toRole": "gate"
      }
    ],
    "provenance": [
      "inspect_model on VCV Rack 2.6.6 (Core) / Fundamental 2.6.4; port and parameter ids/names verified (no params; 16 mono Channel inputs portId 0-15; single Polyphonic output portId 0)",
      "Semantics from well-known VCV Fundamental Merge behavior: combines mono cables into one polyphonic cable, counterpart to Split"
    ]
  },
  {
    "adapterVersion": 1,
    "pluginSlug": "Fundamental",
    "modelSlug": "Split",
    "pluginVersionRange": ">=2.6.0 <3.0.0",
    "displayName": "Split",
    "summary": "Split takes a single polyphonic cable on its input and breaks it out into up to 16 individual monophonic channel signals, one per numbered output jack. It is a signal-agnostic polyphony utility: each active channel of the input (pitch, gate, audio, or CV) is exposed as a separate mono output so individual voices can be routed to monophonic modules. In a subtractive patch it is commonly used to fan a polyphonic pitch or gate bus out to per-voice VCOs, envelopes, or filters.",
    "params": [],
    "inputs": [
      {
        "portId": 0,
        "role": "unknown",
        "key": "poly_in",
        "polyphony": "polyphonic",
        "description": "Polyphonic input cable. Carries 1-16 channels of any signal type (pitch, gate, audio, or CV); the number of active channels here determines how many channel outputs carry signal."
      }
    ],
    "outputs": [
      {
        "portId": 0,
        "role": "unknown",
        "key": "channel_1_out",
        "polyphony": "monophonic",
        "description": "Monophonic output carrying channel 1 of the polyphonic input."
      },
      {
        "portId": 1,
        "role": "unknown",
        "key": "channel_2_out",
        "polyphony": "monophonic",
        "description": "Monophonic output carrying channel 2 of the polyphonic input."
      },
      {
        "portId": 2,
        "role": "unknown",
        "key": "channel_3_out",
        "polyphony": "monophonic",
        "description": "Monophonic output carrying channel 3 of the polyphonic input."
      },
      {
        "portId": 3,
        "role": "unknown",
        "key": "channel_4_out",
        "polyphony": "monophonic",
        "description": "Monophonic output carrying channel 4 of the polyphonic input."
      },
      {
        "portId": 4,
        "role": "unknown",
        "key": "channel_5_out",
        "polyphony": "monophonic",
        "description": "Monophonic output carrying channel 5 of the polyphonic input."
      },
      {
        "portId": 5,
        "role": "unknown",
        "key": "channel_6_out",
        "polyphony": "monophonic",
        "description": "Monophonic output carrying channel 6 of the polyphonic input."
      },
      {
        "portId": 6,
        "role": "unknown",
        "key": "channel_7_out",
        "polyphony": "monophonic",
        "description": "Monophonic output carrying channel 7 of the polyphonic input."
      },
      {
        "portId": 7,
        "role": "unknown",
        "key": "channel_8_out",
        "polyphony": "monophonic",
        "description": "Monophonic output carrying channel 8 of the polyphonic input."
      },
      {
        "portId": 8,
        "role": "unknown",
        "key": "channel_9_out",
        "polyphony": "monophonic",
        "description": "Monophonic output carrying channel 9 of the polyphonic input."
      },
      {
        "portId": 9,
        "role": "unknown",
        "key": "channel_10_out",
        "polyphony": "monophonic",
        "description": "Monophonic output carrying channel 10 of the polyphonic input."
      },
      {
        "portId": 10,
        "role": "unknown",
        "key": "channel_11_out",
        "polyphony": "monophonic",
        "description": "Monophonic output carrying channel 11 of the polyphonic input."
      },
      {
        "portId": 11,
        "role": "unknown",
        "key": "channel_12_out",
        "polyphony": "monophonic",
        "description": "Monophonic output carrying channel 12 of the polyphonic input."
      },
      {
        "portId": 12,
        "role": "unknown",
        "key": "channel_13_out",
        "polyphony": "monophonic",
        "description": "Monophonic output carrying channel 13 of the polyphonic input."
      },
      {
        "portId": 13,
        "role": "unknown",
        "key": "channel_14_out",
        "polyphony": "monophonic",
        "description": "Monophonic output carrying channel 14 of the polyphonic input."
      },
      {
        "portId": 14,
        "role": "unknown",
        "key": "channel_15_out",
        "polyphony": "monophonic",
        "description": "Monophonic output carrying channel 15 of the polyphonic input."
      },
      {
        "portId": 15,
        "role": "unknown",
        "key": "channel_16_out",
        "polyphony": "monophonic",
        "description": "Monophonic output carrying channel 16 of the polyphonic input."
      }
    ],
    "polyphony": "poly_from_input",
    "opaqueStateFields": [],
    "validationRules": [],
    "connectionRecipes": [
      {
        "name": "Poly pitch bus to per-voice VCO",
        "description": "Feed one channel output into a VCO 1V/oct input to drive an individual voice from a polyphonic pitch bus (e.g. from a MIDI-CV interface).",
        "fromOutputKey": "channel_1_out",
        "toRole": "pitch_voct"
      },
      {
        "name": "Poly gate bus to per-voice envelope",
        "description": "Feed one channel output into an envelope gate/trigger input to fire a single voice's envelope from a polyphonic gate bus.",
        "fromOutputKey": "channel_1_out",
        "toRole": "gate"
      },
      {
        "name": "Poly audio to mono channel",
        "description": "Feed one channel output into a mixer or effect audio input to process a single voice of a polyphonic audio signal on its own.",
        "fromOutputKey": "channel_1_out",
        "toRole": "audio"
      }
    ],
    "provenance": [
      "inspect_model on VCV Rack 2.6.6 (Core) / Fundamental 2.6.4; port and parameter ids/names verified",
      "Split has no parameters and one polyphonic input fanned out to 16 monophonic channel outputs per verified metadata; signal roles left unknown because the module is signal-type-agnostic",
      "Adversarially verified against provided ground truth (Fundamental/Split): input portId 0 (Polyphonic) and output portIds 0-15 (Channel 1-16) all match; no params; no phantom or dropped ports"
    ]
  },
  {
    "adapterVersion": 1,
    "pluginSlug": "Fundamental",
    "modelSlug": "Octave",
    "pluginVersionRange": ">=2.6.0 <3.0.0",
    "displayName": "Octave",
    "summary": "Octave is a pitch transposition utility. It takes a 1V/octave pitch signal and shifts it up or down by whole octaves using the Shift knob (-4 to +4), with an optional Octave shift CV input adding further transposition, and outputs the resulting 1V/octave pitch. In a subtractive patch it sits between a pitch source (sequencer, MIDI-to-CV, or keyboard) and one or more VCOs to change register or stack voices at different octaves.",
    "polyphony": "poly_from_input",
    "params": [
      {
        "paramId": 0,
        "role": "octave_shift",
        "safeInitial": 0,
        "safeRange": [
          -4,
          4
        ],
        "description": "Transposes the incoming pitch by whole octaves, from -4 to +4 octaves (each step is 1V on the 1V/octave standard). Default 0 leaves pitch unchanged."
      }
    ],
    "inputs": [
      {
        "portId": 0,
        "role": "pitch_voct",
        "key": "pitch_in",
        "polyphony": "poly_from_input"
      },
      {
        "portId": 1,
        "role": "cv_bipolar",
        "key": "octave_shift_cv",
        "polyphony": "poly_from_input"
      }
    ],
    "outputs": [
      {
        "portId": 0,
        "role": "pitch_voct",
        "key": "pitch_out",
        "polyphony": "poly_from_input"
      }
    ],
    "opaqueStateFields": [],
    "validationRules": [],
    "connectionRecipes": [
      {
        "name": "Octave to VCO pitch",
        "description": "Feed the octave-shifted pitch into a VCO's 1V/octave pitch input to play it in the transposed register.",
        "fromOutputKey": "pitch_out",
        "toRole": "pitch_voct"
      },
      {
        "name": "Octave to quantizer",
        "description": "Route the transposed pitch into a quantizer or another pitch-processing module expecting a 1V/octave signal.",
        "fromOutputKey": "pitch_out",
        "toRole": "pitch_voct"
      }
    ],
    "provenance": [
      "inspect_model on VCV Rack 2.6.6 (Core) / Fundamental 2.6.4; parameter and port ids/names verified against live model metadata"
    ]
  },
  {
    "adapterVersion": 1,
    "pluginSlug": "Fundamental",
    "modelSlug": "8vert",
    "pluginVersionRange": ">=2.6.0 <3.0.0",
    "displayName": "8vert",
    "summary": "8vert is a bank of eight independent attenuverters. Each row scales its input signal by a bipolar gain from -1 to +1, so a channel can attenuate, mute, pass, or invert either audio or CV. In a subtractive patch it is a utility stage for trimming modulation depth, inverting LFOs and envelopes, and scaling audio or control signals before they reach a destination.",
    "params": [
      {
        "paramId": 0,
        "role": "cv_attenuverter",
        "safeInitial": 0,
        "safeRange": [
          -1,
          1
        ],
        "description": "Row 1 attenuverter gain: -1 fully inverts the Row 1 input, 0 mutes it, +1 passes it at unity. Bipolar scaling of the Row 1 signal."
      },
      {
        "paramId": 1,
        "role": "cv_attenuverter",
        "safeInitial": 0,
        "safeRange": [
          -1,
          1
        ],
        "description": "Row 2 attenuverter gain: -1 fully inverts the Row 2 input, 0 mutes it, +1 passes it at unity. Bipolar scaling of the Row 2 signal."
      },
      {
        "paramId": 2,
        "role": "cv_attenuverter",
        "safeInitial": 0,
        "safeRange": [
          -1,
          1
        ],
        "description": "Row 3 attenuverter gain: -1 fully inverts the Row 3 input, 0 mutes it, +1 passes it at unity. Bipolar scaling of the Row 3 signal."
      },
      {
        "paramId": 3,
        "role": "cv_attenuverter",
        "safeInitial": 0,
        "safeRange": [
          -1,
          1
        ],
        "description": "Row 4 attenuverter gain: -1 fully inverts the Row 4 input, 0 mutes it, +1 passes it at unity. Bipolar scaling of the Row 4 signal."
      },
      {
        "paramId": 4,
        "role": "cv_attenuverter",
        "safeInitial": 0,
        "safeRange": [
          -1,
          1
        ],
        "description": "Row 5 attenuverter gain: -1 fully inverts the Row 5 input, 0 mutes it, +1 passes it at unity. Bipolar scaling of the Row 5 signal."
      },
      {
        "paramId": 5,
        "role": "cv_attenuverter",
        "safeInitial": 0,
        "safeRange": [
          -1,
          1
        ],
        "description": "Row 6 attenuverter gain: -1 fully inverts the Row 6 input, 0 mutes it, +1 passes it at unity. Bipolar scaling of the Row 6 signal."
      },
      {
        "paramId": 6,
        "role": "cv_attenuverter",
        "safeInitial": 0,
        "safeRange": [
          -1,
          1
        ],
        "description": "Row 7 attenuverter gain: -1 fully inverts the Row 7 input, 0 mutes it, +1 passes it at unity. Bipolar scaling of the Row 7 signal."
      },
      {
        "paramId": 7,
        "role": "cv_attenuverter",
        "safeInitial": 0,
        "safeRange": [
          -1,
          1
        ],
        "description": "Row 8 attenuverter gain: -1 fully inverts the Row 8 input, 0 mutes it, +1 passes it at unity. Bipolar scaling of the Row 8 signal."
      }
    ],
    "inputs": [
      {
        "portId": 0,
        "role": "cv_bipolar",
        "key": "row1_in",
        "polyphony": "poly_from_input",
        "description": "Row 1 signal input; scaled by the Row 1 attenuverter gain. Accepts audio or CV."
      },
      {
        "portId": 1,
        "role": "cv_bipolar",
        "key": "row2_in",
        "polyphony": "poly_from_input",
        "description": "Row 2 signal input; scaled by the Row 2 attenuverter gain. Accepts audio or CV."
      },
      {
        "portId": 2,
        "role": "cv_bipolar",
        "key": "row3_in",
        "polyphony": "poly_from_input",
        "description": "Row 3 signal input; scaled by the Row 3 attenuverter gain. Accepts audio or CV."
      },
      {
        "portId": 3,
        "role": "cv_bipolar",
        "key": "row4_in",
        "polyphony": "poly_from_input",
        "description": "Row 4 signal input; scaled by the Row 4 attenuverter gain. Accepts audio or CV."
      },
      {
        "portId": 4,
        "role": "cv_bipolar",
        "key": "row5_in",
        "polyphony": "poly_from_input",
        "description": "Row 5 signal input; scaled by the Row 5 attenuverter gain. Accepts audio or CV."
      },
      {
        "portId": 5,
        "role": "cv_bipolar",
        "key": "row6_in",
        "polyphony": "poly_from_input",
        "description": "Row 6 signal input; scaled by the Row 6 attenuverter gain. Accepts audio or CV."
      },
      {
        "portId": 6,
        "role": "cv_bipolar",
        "key": "row7_in",
        "polyphony": "poly_from_input",
        "description": "Row 7 signal input; scaled by the Row 7 attenuverter gain. Accepts audio or CV."
      },
      {
        "portId": 7,
        "role": "cv_bipolar",
        "key": "row8_in",
        "polyphony": "poly_from_input",
        "description": "Row 8 signal input; scaled by the Row 8 attenuverter gain. Accepts audio or CV."
      }
    ],
    "outputs": [
      {
        "portId": 0,
        "role": "cv_bipolar",
        "key": "row1_out",
        "polyphony": "poly_from_input",
        "description": "Row 1 output: the Row 1 input scaled (and optionally inverted) by the Row 1 gain."
      },
      {
        "portId": 1,
        "role": "cv_bipolar",
        "key": "row2_out",
        "polyphony": "poly_from_input",
        "description": "Row 2 output: the Row 2 input scaled (and optionally inverted) by the Row 2 gain."
      },
      {
        "portId": 2,
        "role": "cv_bipolar",
        "key": "row3_out",
        "polyphony": "poly_from_input",
        "description": "Row 3 output: the Row 3 input scaled (and optionally inverted) by the Row 3 gain."
      },
      {
        "portId": 3,
        "role": "cv_bipolar",
        "key": "row4_out",
        "polyphony": "poly_from_input",
        "description": "Row 4 output: the Row 4 input scaled (and optionally inverted) by the Row 4 gain."
      },
      {
        "portId": 4,
        "role": "cv_bipolar",
        "key": "row5_out",
        "polyphony": "poly_from_input",
        "description": "Row 5 output: the Row 5 input scaled (and optionally inverted) by the Row 5 gain."
      },
      {
        "portId": 5,
        "role": "cv_bipolar",
        "key": "row6_out",
        "polyphony": "poly_from_input",
        "description": "Row 6 output: the Row 6 input scaled (and optionally inverted) by the Row 6 gain."
      },
      {
        "portId": 6,
        "role": "cv_bipolar",
        "key": "row7_out",
        "polyphony": "poly_from_input",
        "description": "Row 7 output: the Row 7 input scaled (and optionally inverted) by the Row 7 gain."
      },
      {
        "portId": 7,
        "role": "cv_bipolar",
        "key": "row8_out",
        "polyphony": "poly_from_input",
        "description": "Row 8 output: the Row 8 input scaled (and optionally inverted) by the Row 8 gain."
      }
    ],
    "polyphony": "poly_from_input",
    "opaqueStateFields": [],
    "validationRules": [],
    "connectionRecipes": [
      {
        "name": "Attenuvert modulation into a CV destination",
        "description": "Send a scaled or inverted LFO/CV from a row output into a modulation input such as a filter cutoff CV or VCA level CV; the gain knob sets the modulation depth and polarity.",
        "fromOutputKey": "row1_out",
        "toRole": "cv_bipolar"
      },
      {
        "name": "Scale audio level before a mixer or output",
        "description": "Use a row as a simple gain/volume stage, feeding an attenuated audio signal into a mixer channel or the audio output.",
        "fromOutputKey": "row2_out",
        "toRole": "audio"
      },
      {
        "name": "Invert or trim a unipolar envelope",
        "description": "Attenuvert an ADSR/envelope to reduce its depth or flip it, then route to a CV input that expects a unipolar control signal.",
        "fromOutputKey": "row3_out",
        "toRole": "cv_unipolar"
      }
    ],
    "provenance": [
      "inspect_model on VCV Rack 2.6.6 (Core) / Fundamental 2.6.4; all 8 attenuverter params (paramId 0-7, 'Row N gain', min -1, max 1, default 0) and all 8 input/output port ids and names verified against live metadata",
      "Semantics derived from well-known VCV Fundamental 8vert behavior: eight independent per-row attenuverters performing bipolar gain (attenuate/mute/invert) with poly_from_input channel handling; no offset stage",
      "Adversarial verification against supplied ground truth: every paramId (0-7), inputs.portId (0-7), and outputs.portId (0-7) confirmed present with matching ids; generic 'Row N' port names carry no pitch/gate/audio-specific semantics, so cv_bipolar retained; safeInitial 0 and safeRange [-1,1] lie within ground-truth [-1,1]"
    ]
  },
  {
    "adapterVersion": 1,
    "pluginSlug": "Fundamental",
    "modelSlug": "Scope",
    "pluginVersionRange": ">=2.6.0 <3.0.0",
    "displayName": "Scope",
    "summary": "A two-channel oscilloscope for visualizing signals on the patch. It measures and displays waveforms (and can plot Ch 1 vs Ch 2 as an X/Y Lissajous figure) with per-channel gain and offset, a time base, and a trigger for a stable display. It is a diagnostic/analysis utility rather than a sound source or processor; both channel inputs are passed straight through to the matching outputs so it can be inserted inline without altering the signal.",
    "params": [
      {
        "paramId": 0,
        "role": "level",
        "safeInitial": 1,
        "safeRange": [
          0,
          8
        ],
        "description": "Vertical gain (display scaling) for channel 1; higher values zoom the trace amplitude. 0 default shows the raw signal. Does not affect the pass-through output."
      },
      {
        "paramId": 1,
        "role": "offset",
        "safeInitial": 0,
        "safeRange": [
          -10,
          10
        ],
        "description": "Vertical offset applied to channel 1's displayed trace (volts), shifting it up or down on screen. Display-only; does not affect the pass-through output."
      },
      {
        "paramId": 2,
        "role": "level",
        "safeInitial": 1,
        "safeRange": [
          0,
          8
        ],
        "description": "Vertical gain (display scaling) for channel 2; higher values zoom the trace amplitude. 0 default shows the raw signal. Does not affect the pass-through output."
      },
      {
        "paramId": 3,
        "role": "offset",
        "safeInitial": 0,
        "safeRange": [
          -10,
          10
        ],
        "description": "Vertical offset applied to channel 2's displayed trace (volts), shifting it up or down on screen. Display-only; does not affect the pass-through output."
      },
      {
        "paramId": 4,
        "role": "time_base",
        "safeInitial": 1,
        "description": "Horizontal time base (sweep speed) as a log2 value; lower zooms in on fast/audio-rate detail, higher shows slower/CV-rate movement over a wider window."
      },
      {
        "paramId": 5,
        "role": "mode",
        "safeInitial": 0,
        "description": "Display mode toggle. Snapped two-position switch: 0 = \"1 & 2\", both channels plotted against time; 1 = \"1 x 2\", Ch 1 against Ch 2 as an X/Y (Lissajous) plot. Ground-truth default is 0. Display-only; does not affect the pass-through outputs."
      },
      {
        "paramId": 6,
        "role": "trigger_threshold",
        "safeInitial": 0,
        "safeRange": [
          -10,
          10
        ],
        "description": "Trigger level in volts; the sweep starts when the triggering signal crosses this threshold, producing a stable, non-scrolling trace."
      },
      {
        "paramId": 7,
        "role": "trigger_enable",
        "safeInitial": 1,
        "description": "Internal triggering. Snapped two-position switch: 0 = \"Enabled\", the display waits for a threshold crossing to stabilize the waveform; 1 = \"Disabled\", it free-runs. Ground-truth default is 1, so a freshly added Scope free-runs and the Trigger threshold (paramId 6) has no effect until this is switched."
      }
    ],
    "inputs": [
      {
        "portId": 0,
        "role": "unknown",
        "key": "ch1_in",
        "polyphony": "poly_from_input",
        "description": "Channel 1 signal input to be measured/displayed. Accepts any signal (audio or CV); polyphonic channels are accepted and passed through to the Ch 1 output."
      },
      {
        "portId": 1,
        "role": "unknown",
        "key": "ch2_in",
        "polyphony": "poly_from_input",
        "description": "Channel 2 signal input to be measured/displayed. Accepts any signal (audio or CV); polyphonic channels are accepted and passed through to the Ch 2 output."
      },
      {
        "portId": 2,
        "role": "trigger",
        "key": "ext_trigger_in",
        "polyphony": "monophonic",
        "description": "External trigger input. When patched, the scope triggers its sweep from this signal (relative to the trigger threshold) instead of the channel signals, for synchronized display to an external clock or gate."
      }
    ],
    "outputs": [
      {
        "portId": 0,
        "role": "unknown",
        "key": "ch1_out",
        "polyphony": "poly_from_input",
        "description": "Pass-through of the Channel 1 input, unmodified (gain/offset are display-only). Use to daisy-chain the scoped signal onward while monitoring it. Carries whatever signal type feeds Ch 1."
      },
      {
        "portId": 1,
        "role": "unknown",
        "key": "ch2_out",
        "polyphony": "poly_from_input",
        "description": "Pass-through of the Channel 2 input, unmodified (gain/offset are display-only). Use to daisy-chain the scoped signal onward while monitoring it. Carries whatever signal type feeds Ch 2."
      }
    ],
    "polyphony": "poly_from_input",
    "opaqueStateFields": [],
    "validationRules": [],
    "connectionRecipes": [
      {
        "name": "Monitor signal without breaking the chain",
        "description": "Patch a signal into Ch 1 and take Ch 1 out onward to the rest of the patch; the scope displays the signal while passing it through unchanged.",
        "fromOutputKey": "ch1_out",
        "toRole": "audio"
      },
      {
        "name": "Monitor a CV/modulation source inline",
        "description": "Feed an LFO or envelope into Ch 2 and continue from Ch 2 out to a modulation destination, watching the control signal on screen.",
        "fromOutputKey": "ch2_out",
        "toRole": "cv_bipolar"
      }
    ],
    "provenance": [
      "inspect_model on VCV Rack 2.6.6 (Core) / Fundamental 2.6.4; port and parameter ids/names verified against live ground-truth metadata",
      "Roles/semantics defended from parameter and port names plus well-known VCV Fundamental Scope behavior (two-channel oscilloscope with per-channel gain/offset, time base, trigger, X/Y mode, and pass-through outputs)",
      "Adversarial verification pass: all paramIds (0-7), input portIds (0-2), and output portIds (0-1) confirmed present in ground truth with matching names; all safeInitial/safeRange values confirmed within declared [min,max] bounds; draft returned unchanged"
    ]
  },
  {
    "adapterVersion": 1,
    "pluginSlug": "Fundamental",
    "modelSlug": "Noise",
    "pluginVersionRange": ">=2.6.0 <3.0.0",
    "displayName": "Noise",
    "summary": "Noise emits seven simultaneous colors of noise as a pitchless generator source for subtractive synthesis and random modulation.",
    "params": [],
    "inputs": [],
    "outputs": [
      {
        "portId": 0,
        "role": "audio",
        "key": "white_out",
        "description": "White noise — flat (equal) power across the spectrum. Bright, hissy raw source for filtering, percussion, and texture in subtractive synthesis.",
        "polyphony": "monophonic"
      },
      {
        "portId": 1,
        "role": "audio",
        "key": "pink_out",
        "description": "Pink noise — power falls roughly 3 dB per octave (equal energy per octave). Natural, balanced timbre; common for wind and ambience.",
        "polyphony": "monophonic"
      },
      {
        "portId": 2,
        "role": "audio",
        "key": "red_out",
        "description": "Red / Brownian noise — power falls roughly 6 dB per octave. Dark and rumbling; also usable as a smooth, slow random modulation source.",
        "polyphony": "monophonic"
      },
      {
        "portId": 3,
        "role": "audio",
        "key": "violet_out",
        "description": "Violet noise — power rises roughly 6 dB per octave. Very bright and thin, emphasizing high frequencies.",
        "polyphony": "monophonic"
      },
      {
        "portId": 4,
        "role": "audio",
        "key": "blue_out",
        "description": "Blue noise — power rises roughly 3 dB per octave. Bright, high-frequency-weighted noise.",
        "polyphony": "monophonic"
      },
      {
        "portId": 5,
        "role": "audio",
        "key": "gray_out",
        "description": "Gray noise — psychoacoustically weighted so it sounds approximately equally loud across the audible spectrum.",
        "polyphony": "monophonic"
      },
      {
        "portId": 6,
        "role": "audio",
        "key": "black_out",
        "description": "Black noise — heavily low-frequency-weighted (below red), very slow. Useful as a drifting random control voltage more than as an audio source.",
        "polyphony": "monophonic"
      }
    ],
    "polyphony": "monophonic",
    "opaqueStateFields": [],
    "validationRules": [],
    "connectionRecipes": [
      {
        "name": "White noise into a filter",
        "description": "Patch white noise into a VCF audio input as the raw source for subtractive percussion, wind, and noise textures.",
        "fromOutputKey": "white_out",
        "toRole": "audio"
      },
      {
        "name": "Pink noise into a mixer or VCA",
        "description": "Feed pink noise into a mixer or VCA audio input for a natural, spectrally balanced noise layer.",
        "fromOutputKey": "pink_out",
        "toRole": "audio"
      },
      {
        "name": "Red noise as random modulation",
        "description": "Use red (Brownian) noise as a slow, smooth random control voltage into a bipolar CV input such as filter cutoff or oscillator pitch.",
        "fromOutputKey": "red_out",
        "toRole": "cv_bipolar"
      },
      {
        "name": "Black noise as slow drift",
        "description": "Route heavily low-passed black noise into a bipolar CV input for very slow, drifting random modulation.",
        "fromOutputKey": "black_out",
        "toRole": "cv_bipolar"
      }
    ],
    "provenance": [
      "inspect_model on VCV Rack 2.6.6 (Core) / Fundamental 2.6.4; output port ids and names verified",
      "Ground truth confirms zero params and zero inputs; module is a free-running generator",
      "Noise-color spectral semantics from standard noise-color definitions and VCV Fundamental Noise behavior",
      "Adversarial verification: all 7 output portIds (0-6) match ground truth; roles are audio (noise ports carry no pitch/gate/CV semantics); no ports dropped; no params to bounds-check"
    ]
  },
  {
    "adapterVersion": 1,
    "pluginSlug": "Fundamental",
    "modelSlug": "Delay",
    "pluginVersionRange": ">=2.6.0 <3.0.0",
    "displayName": "Delay",
    "summary": "A stereo-capable delay/echo effect that records the incoming audio and plays it back after a controllable time, with feedback for repeats, a tone filter shaping the color of the repeats, and a dry/wet mix. In a subtractive patch it is a time-based effect placed after the VCA/VCF to add echo, space, and rhythmic repeats, and its feedback and tone controls can be pushed for dub-style and self-oscillating textures.",
    "params": [
      {
        "paramId": 0,
        "role": "delay_time",
        "safeInitial": 0.6747425198554993,
        "safeRange": [
          0,
          1
        ],
        "description": "Delay time knob. Sets the base delay/echo length; higher values produce longer delays. When a signal is patched into the Clock input this sets a clock division/multiple instead."
      },
      {
        "paramId": 1,
        "role": "feedback",
        "safeInitial": 0.5,
        "safeRange": [
          0,
          0.85
        ],
        "description": "Feedback amount. Controls how much of the delayed signal is fed back into the delay line, setting the number of repeats. Values near maximum can self-oscillate and build to runaway levels, so the safe range is capped below full."
      },
      {
        "paramId": 2,
        "role": "tone",
        "safeInitial": 0.5,
        "description": "Tone control. A tilt/filter on the delayed signal: lower settings darken the repeats (more low-pass) and higher settings brighten them, shaping how the echoes decay in the spectrum."
      },
      {
        "paramId": 3,
        "role": "mix",
        "safeInitial": 0.5,
        "description": "Dry/wet mix for the Mix output. At minimum the output is fully dry (input), at maximum fully wet (delayed signal); 0.5 is an equal blend."
      },
      {
        "paramId": 4,
        "role": "cv_attenuverter",
        "safeInitial": 0,
        "description": "Attenuverter for the Time CV input. Scales and can invert the modulation applied to delay time; centered at 0 for no CV effect."
      },
      {
        "paramId": 5,
        "role": "cv_attenuverter",
        "safeInitial": 0,
        "description": "Attenuverter for the Feedback CV input. Scales and can invert the modulation applied to feedback; centered at 0 for no CV effect."
      },
      {
        "paramId": 6,
        "role": "cv_attenuverter",
        "safeInitial": 0,
        "description": "Attenuverter for the Tone CV input. Scales and can invert the modulation applied to tone; centered at 0 for no CV effect."
      },
      {
        "paramId": 7,
        "role": "cv_attenuverter",
        "safeInitial": 0,
        "description": "Attenuverter for the Mix CV input. Scales and can invert the modulation applied to the dry/wet mix; centered at 0 for no CV effect."
      }
    ],
    "inputs": [
      {
        "portId": 0,
        "role": "cv_bipolar",
        "key": "time_cv",
        "polyphony": "poly_from_input",
        "description": "Time CV input. Modulates delay time, scaled and inverted by the Time CV attenuverter (paramId 4)."
      },
      {
        "portId": 1,
        "role": "cv_bipolar",
        "key": "feedback_cv",
        "polyphony": "poly_from_input",
        "description": "Feedback CV input. Modulates feedback amount, scaled and inverted by the Feedback CV attenuverter (paramId 5)."
      },
      {
        "portId": 2,
        "role": "cv_bipolar",
        "key": "tone_cv",
        "polyphony": "poly_from_input",
        "description": "Tone CV input. Modulates the tone/filter, scaled and inverted by the Tone CV attenuverter (paramId 6)."
      },
      {
        "portId": 3,
        "role": "cv_bipolar",
        "key": "mix_cv",
        "polyphony": "poly_from_input",
        "description": "Mix CV input. Modulates the dry/wet mix, scaled and inverted by the Mix CV attenuverter (paramId 7)."
      },
      {
        "portId": 4,
        "role": "audio",
        "key": "audio_in",
        "polyphony": "poly_from_input",
        "description": "Main audio input to be delayed. This is the source signal fed into the delay line."
      },
      {
        "portId": 5,
        "role": "clock",
        "key": "clock_in",
        "polyphony": "monophonic",
        "description": "Clock input. When patched, the delay time is synced to the incoming clock (with the Time knob selecting a division/multiplication) instead of being set in free-running seconds."
      }
    ],
    "outputs": [
      {
        "portId": 0,
        "role": "audio",
        "key": "mix_out",
        "polyphony": "poly_from_input",
        "description": "Mix output: the blend of dry input and wet delayed signal according to the Mix control (and its CV). This is the primary output for using the module as an insert effect."
      },
      {
        "portId": 1,
        "role": "audio",
        "key": "wet_out",
        "polyphony": "poly_from_input",
        "description": "Wet output: the fully wet delayed signal only, independent of the Mix setting. Useful for parallel/send-return routing where the dry path is handled elsewhere."
      }
    ],
    "polyphony": "poly_from_input",
    "opaqueStateFields": [],
    "validationRules": [],
    "connectionRecipes": [
      {
        "name": "Delay Mix into mixer/output",
        "description": "Patch the Mix output into a mixer channel or audio output to hear the delayed signal blended with the dry source as an insert effect.",
        "fromOutputKey": "mix_out",
        "toRole": "audio"
      },
      {
        "name": "Wet-only send/return",
        "description": "Patch the Wet output into a mixer return or downstream effect to process only the delayed signal in a parallel path.",
        "fromOutputKey": "wet_out",
        "toRole": "audio"
      },
      {
        "name": "Feedback loop into next effect",
        "description": "Route the Wet output through another effect (e.g. a filter or reverb) and back to build evolving delay textures.",
        "fromOutputKey": "wet_out",
        "toRole": "audio"
      }
    ],
    "provenance": [
      "inspect_model on VCV Rack 2.6.6 (Core) / Fundamental 2.6.4; port and parameter ids/names verified",
      "Semantics defended from parameter/port names and well-known VCV Fundamental Delay behavior (Time/Feedback/Tone/Mix with per-control CV inputs and attenuverters, Audio and Clock inputs, Mix and Wet outputs)",
      "Adversarial verification against ground truth: all paramIds 0-7, input portIds 0-5, output portIds 0-1 confirmed present with matching ids; roles, safeInitial and safeRange checked within [min,max]; draft required no corrections"
    ]
  },
  {
    "adapterVersion": 1,
    "pluginSlug": "Fundamental",
    "modelSlug": "SEQ3",
    "pluginVersionRange": ">=2.6.0 <3.0.0",
    "displayName": "SEQ 3",
    "summary": "An 8-step, 3-channel CV/gate step sequencer with an internal clock (or external clock input). Each step holds three independent CV values (CV 1/2/3) and a per-step trigger enable, making it the pattern/modulation source in a patch: its CV rows drive VCO pitch or filter/VCA modulation while its trigger and per-step gate outputs fire envelopes and gates. Transport (clock, run, reset, steps) can be driven externally and passed through to chain multiple SEQ 3 units.",
    "polyphony": "monophonic",
    "params": [
      {
        "paramId": 0,
        "role": "tempo",
        "safeInitial": 1,
        "description": "Internal clock tempo (exponential; default centers around ~120 BPM). Sets the base rate when no external clock is patched, and the center that Tempo CV modulates."
      },
      {
        "paramId": 1,
        "role": "run",
        "safeInitial": 0,
        "description": "Run/stop toggle for the sequencer transport (0 = stopped, 1 = running)."
      },
      {
        "paramId": 2,
        "role": "reset",
        "safeInitial": 0,
        "description": "Reset control; returns the sequence to step 1."
      },
      {
        "paramId": 3,
        "role": "steps",
        "safeInitial": 8,
        "description": "Number of active steps in the pattern (1-8) before it loops."
      },
      {
        "paramId": 4,
        "role": "step_cv",
        "safeInitial": 0,
        "description": "Channel 1 CV value for step 1 (-10..+10 V); commonly used as 1V/oct pitch or as modulation."
      },
      {
        "paramId": 5,
        "role": "step_cv",
        "safeInitial": 0,
        "description": "Channel 1 CV value for step 2 (-10..+10 V)."
      },
      {
        "paramId": 6,
        "role": "step_cv",
        "safeInitial": 0,
        "description": "Channel 1 CV value for step 3 (-10..+10 V)."
      },
      {
        "paramId": 7,
        "role": "step_cv",
        "safeInitial": 0,
        "description": "Channel 1 CV value for step 4 (-10..+10 V)."
      },
      {
        "paramId": 8,
        "role": "step_cv",
        "safeInitial": 0,
        "description": "Channel 1 CV value for step 5 (-10..+10 V)."
      },
      {
        "paramId": 9,
        "role": "step_cv",
        "safeInitial": 0,
        "description": "Channel 1 CV value for step 6 (-10..+10 V)."
      },
      {
        "paramId": 10,
        "role": "step_cv",
        "safeInitial": 0,
        "description": "Channel 1 CV value for step 7 (-10..+10 V)."
      },
      {
        "paramId": 11,
        "role": "step_cv",
        "safeInitial": 0,
        "description": "Channel 1 CV value for step 8 (-10..+10 V)."
      },
      {
        "paramId": 12,
        "role": "step_cv",
        "safeInitial": 0,
        "description": "Channel 2 CV value for step 1 (-10..+10 V)."
      },
      {
        "paramId": 13,
        "role": "step_cv",
        "safeInitial": 0,
        "description": "Channel 2 CV value for step 2 (-10..+10 V)."
      },
      {
        "paramId": 14,
        "role": "step_cv",
        "safeInitial": 0,
        "description": "Channel 2 CV value for step 3 (-10..+10 V)."
      },
      {
        "paramId": 15,
        "role": "step_cv",
        "safeInitial": 0,
        "description": "Channel 2 CV value for step 4 (-10..+10 V)."
      },
      {
        "paramId": 16,
        "role": "step_cv",
        "safeInitial": 0,
        "description": "Channel 2 CV value for step 5 (-10..+10 V)."
      },
      {
        "paramId": 17,
        "role": "step_cv",
        "safeInitial": 0,
        "description": "Channel 2 CV value for step 6 (-10..+10 V)."
      },
      {
        "paramId": 18,
        "role": "step_cv",
        "safeInitial": 0,
        "description": "Channel 2 CV value for step 7 (-10..+10 V)."
      },
      {
        "paramId": 19,
        "role": "step_cv",
        "safeInitial": 0,
        "description": "Channel 2 CV value for step 8 (-10..+10 V)."
      },
      {
        "paramId": 20,
        "role": "step_cv",
        "safeInitial": 0,
        "description": "Channel 3 CV value for step 1 (-10..+10 V)."
      },
      {
        "paramId": 21,
        "role": "step_cv",
        "safeInitial": 0,
        "description": "Channel 3 CV value for step 2 (-10..+10 V)."
      },
      {
        "paramId": 22,
        "role": "step_cv",
        "safeInitial": 0,
        "description": "Channel 3 CV value for step 3 (-10..+10 V)."
      },
      {
        "paramId": 23,
        "role": "step_cv",
        "safeInitial": 0,
        "description": "Channel 3 CV value for step 4 (-10..+10 V)."
      },
      {
        "paramId": 24,
        "role": "step_cv",
        "safeInitial": 0,
        "description": "Channel 3 CV value for step 5 (-10..+10 V)."
      },
      {
        "paramId": 25,
        "role": "step_cv",
        "safeInitial": 0,
        "description": "Channel 3 CV value for step 6 (-10..+10 V)."
      },
      {
        "paramId": 26,
        "role": "step_cv",
        "safeInitial": 0,
        "description": "Channel 3 CV value for step 7 (-10..+10 V)."
      },
      {
        "paramId": 27,
        "role": "step_cv",
        "safeInitial": 0,
        "description": "Channel 3 CV value for step 8 (-10..+10 V)."
      },
      {
        "paramId": 28,
        "role": "step_gate",
        "safeInitial": 0,
        "description": "Enables the gate/trigger on step 1; when on, the Trigger output (and step 1 gate) fires on that step."
      },
      {
        "paramId": 29,
        "role": "step_gate",
        "safeInitial": 0,
        "description": "Enables the gate/trigger on step 2."
      },
      {
        "paramId": 30,
        "role": "step_gate",
        "safeInitial": 0,
        "description": "Enables the gate/trigger on step 3."
      },
      {
        "paramId": 31,
        "role": "step_gate",
        "safeInitial": 0,
        "description": "Enables the gate/trigger on step 4."
      },
      {
        "paramId": 32,
        "role": "step_gate",
        "safeInitial": 0,
        "description": "Enables the gate/trigger on step 5."
      },
      {
        "paramId": 33,
        "role": "step_gate",
        "safeInitial": 0,
        "description": "Enables the gate/trigger on step 6."
      },
      {
        "paramId": 34,
        "role": "step_gate",
        "safeInitial": 0,
        "description": "Enables the gate/trigger on step 7."
      },
      {
        "paramId": 35,
        "role": "step_gate",
        "safeInitial": 0,
        "description": "Enables the gate/trigger on step 8."
      },
      {
        "paramId": 36,
        "role": "cv_attenuator",
        "safeInitial": 1,
        "description": "Attenuates the Tempo CV input signal (0..1) before it modulates the clock tempo."
      },
      {
        "paramId": 37,
        "role": "cv_attenuator",
        "safeInitial": 1,
        "description": "Attenuates the Steps CV input signal (0..1) before it sets the active step count."
      },
      {
        "paramId": 38,
        "role": "unknown",
        "safeInitial": 0,
        "description": "Binary 'Clock'-labeled control (0..1, default 0); exact function is not determinable from metadata alone. Retained so the validator can range-check it."
      }
    ],
    "inputs": [
      {
        "portId": 0,
        "role": "cv_bipolar",
        "key": "tempo_cv_in",
        "polyphony": "monophonic",
        "description": "Tempo CV input; modulates the internal clock rate (scaled by the Tempo CV attenuator)."
      },
      {
        "portId": 1,
        "role": "clock",
        "key": "clock_in",
        "polyphony": "monophonic",
        "description": "External clock input; when patched, advances the sequence instead of the internal clock."
      },
      {
        "portId": 2,
        "role": "trigger",
        "key": "reset_in",
        "polyphony": "monophonic",
        "description": "Reset trigger input; a rising edge returns the sequence to step 1."
      },
      {
        "portId": 3,
        "role": "cv_unipolar",
        "key": "steps_cv_in",
        "polyphony": "monophonic",
        "description": "Steps CV input; sets the number of active steps (scaled by the Steps CV attenuator)."
      },
      {
        "portId": 4,
        "role": "trigger",
        "key": "run_in",
        "polyphony": "monophonic",
        "description": "Run input; a trigger toggles the run/stop transport state."
      }
    ],
    "outputs": [
      {
        "portId": 0,
        "role": "trigger",
        "key": "trig_out",
        "polyphony": "monophonic",
        "description": "Trigger/gate output that fires on steps whose trigger is enabled, synchronized to the clock."
      },
      {
        "portId": 1,
        "role": "cv_bipolar",
        "key": "cv1_out",
        "polyphony": "monophonic",
        "description": "Channel 1 sequenced CV output (-10..+10 V); commonly patched to VCO 1V/oct pitch."
      },
      {
        "portId": 2,
        "role": "cv_bipolar",
        "key": "cv2_out",
        "polyphony": "monophonic",
        "description": "Channel 2 sequenced CV output (-10..+10 V); modulation or pitch."
      },
      {
        "portId": 3,
        "role": "cv_bipolar",
        "key": "cv3_out",
        "polyphony": "monophonic",
        "description": "Channel 3 sequenced CV output (-10..+10 V); modulation or pitch."
      },
      {
        "portId": 4,
        "role": "gate",
        "key": "step1_gate",
        "polyphony": "monophonic",
        "description": "Per-step gate output; high while step 1 is the current step."
      },
      {
        "portId": 5,
        "role": "gate",
        "key": "step2_gate",
        "polyphony": "monophonic",
        "description": "Per-step gate output; high while step 2 is the current step."
      },
      {
        "portId": 6,
        "role": "gate",
        "key": "step3_gate",
        "polyphony": "monophonic",
        "description": "Per-step gate output; high while step 3 is the current step."
      },
      {
        "portId": 7,
        "role": "gate",
        "key": "step4_gate",
        "polyphony": "monophonic",
        "description": "Per-step gate output; high while step 4 is the current step."
      },
      {
        "portId": 8,
        "role": "gate",
        "key": "step5_gate",
        "polyphony": "monophonic",
        "description": "Per-step gate output; high while step 5 is the current step."
      },
      {
        "portId": 9,
        "role": "gate",
        "key": "step6_gate",
        "polyphony": "monophonic",
        "description": "Per-step gate output; high while step 6 is the current step."
      },
      {
        "portId": 10,
        "role": "gate",
        "key": "step7_gate",
        "polyphony": "monophonic",
        "description": "Per-step gate output; high while step 7 is the current step."
      },
      {
        "portId": 11,
        "role": "gate",
        "key": "step8_gate",
        "polyphony": "monophonic",
        "description": "Per-step gate output; high while step 8 is the current step."
      },
      {
        "portId": 12,
        "role": "cv_unipolar",
        "key": "steps_out",
        "polyphony": "monophonic",
        "description": "Steps pass-through output (mirrors the active step-count signal) for daisy-chaining SEQ 3 units."
      },
      {
        "portId": 13,
        "role": "clock",
        "key": "clock_out",
        "polyphony": "monophonic",
        "description": "Clock pass-through output for chaining the transport to another sequencer/SEQ 3."
      },
      {
        "portId": 14,
        "role": "gate",
        "key": "run_out",
        "polyphony": "monophonic",
        "description": "Run pass-through output; high while the sequencer is running, for chaining transport state."
      },
      {
        "portId": 15,
        "role": "trigger",
        "key": "reset_out",
        "polyphony": "monophonic",
        "description": "Reset pass-through output for chaining reset to another sequencer/SEQ 3."
      }
    ],
    "opaqueStateFields": [],
    "validationRules": [],
    "connectionRecipes": [
      {
        "name": "CV 1 to VCO pitch",
        "description": "Patch the channel 1 sequenced CV into a VCO's 1V/oct input to sequence pitch (the classic melodic sequencer role).",
        "fromOutputKey": "cv1_out",
        "toRole": "pitch_voct"
      },
      {
        "name": "Trigger to envelope gate",
        "description": "Patch the Trigger output into an ADSR/envelope gate input so enabled steps fire the envelope.",
        "fromOutputKey": "trig_out",
        "toRole": "gate"
      },
      {
        "name": "CV 2 to filter cutoff",
        "description": "Patch a second CV row into a VCF cutoff CV input for per-step timbral modulation.",
        "fromOutputKey": "cv2_out",
        "toRole": "cv_bipolar"
      },
      {
        "name": "Clock thru to next sequencer",
        "description": "Patch the Clock pass-through output into another sequencer/SEQ 3 clock input to keep multiple sequencers in sync.",
        "fromOutputKey": "clock_out",
        "toRole": "clock"
      }
    ],
    "provenance": [
      "inspect_model on VCV Rack 2.6.6 (Core) / Fundamental 2.6.4; all 39 parameter and 21 port ids/names verified against the live module.",
      "Adversarially re-verified against ground-truth SEQ3 metadata: every paramId (0-38), input portId (0-4), and output portId (0-15) exists with matching id/name; signal roles match port names; all safeInitial values lie within their ground-truth [min,max]. Draft required no id/role/range corrections.",
      "Semantics derived from parameter/port names and well-known VCV Fundamental SEQ 3 behavior (3-channel 8-step CV sequencer with internal/external clock and transport pass-through outputs for chaining)."
    ]
  },
  {
    "adapterVersion": 1,
    "pluginSlug": "RackMCP",
    "modelSlug": "Bridge",
    "pluginVersionRange": ">=2.0.0 <3.0.0",
    "displayName": "RackMCP-Bridge",
    "summary": "Control and status utility for the RackMCP local bridge. Its panel surfaces connection, writer-lease, and unsaved-patch state, and it exposes a single momentary button that rotates the pairing secret and invalidates existing client pairings. It carries no audio, CV, gate, or clock signals and plays no part in a subtractive-synth signal chain — it is infrastructure for the MCP link rather than a sound source or processor.",
    "params": [
      {
        "paramId": 0,
        "role": "reset",
        "safeInitial": 0,
        "safeRange": [
          0,
          1
        ],
        "description": "Momentary button (configButton, min 0 / max 1 / default 0) that rotates the bridge pairing secret; a value crossing to 1 fires a one-shot pairing reset that invalidates existing client pairings. Not an audio or CV parameter — its safe resting value is 0."
      }
    ],
    "inputs": [],
    "outputs": [],
    "polyphony": "monophonic",
    "opaqueStateFields": [],
    "validationRules": [],
    "connectionRecipes": [],
    "provenance": [
      "inspect_model on VCV Rack 2.6.6 (Core) / Fundamental 2.6.4; single param id/name verified.",
      "Ground truth cross-checked against configButton(RESET_PARAM, \"Reset pairing secret\") with INPUTS_LEN==0 and OUTPUTS_LEN==0 in plugins/RackMCP/src/rackside/BridgeModule.cpp; module has no inputs or outputs and no signal-path outputs, so no connection recipes are asserted.",
      "Verification correction: pluginVersionRange changed from \">=0.1.0 <1.0.0\" to \">=2.0.0 <3.0.0\" to include the actual plugin version 2.0.0 declared in plugins/RackMCP/plugin.json (the draft range excluded the shipped version)."
    ]
  },
  {
    "adapterVersion": 1,
    "pluginSlug": "RackMCP",
    "modelSlug": "Probe",
    "pluginVersionRange": ">=2.0.0 <3.0.0",
    "displayName": "RackMCP-Probe",
    "summary": "Signal-analysis instrument with eight generic probe inputs. Any cable branched into a probe input is measured non-invasively -- the module accumulates per-channel voltage statistics over a rolling window and publishes them as telemetry to the RackMCP knowledge layer, without altering or passing through the signal. In a subtractive-synth patch it is used as a measurement tap: mult a VCO, filter, envelope, LFO, or gate signal into a probe input to observe it, since the module exposes no audio path of its own (no parameters, no outputs).",
    "params": [],
    "inputs": [
      {
        "portId": 0,
        "role": "unknown",
        "key": "probe_1_in",
        "polyphony": "poly_from_input",
        "description": "Probe 1: generic measurement tap. Accepts any signal (audio, CV, pitch, gate, clock); voltage statistics are accumulated per polyphony channel of the patched cable. Signal is measured only, never modified or passed through."
      },
      {
        "portId": 1,
        "role": "unknown",
        "key": "probe_2_in",
        "polyphony": "poly_from_input",
        "description": "Probe 2: generic measurement tap. Accepts any signal; channel count follows the patched cable."
      },
      {
        "portId": 2,
        "role": "unknown",
        "key": "probe_3_in",
        "polyphony": "poly_from_input",
        "description": "Probe 3: generic measurement tap. Accepts any signal; channel count follows the patched cable."
      },
      {
        "portId": 3,
        "role": "unknown",
        "key": "probe_4_in",
        "polyphony": "poly_from_input",
        "description": "Probe 4: generic measurement tap. Accepts any signal; channel count follows the patched cable."
      },
      {
        "portId": 4,
        "role": "unknown",
        "key": "probe_5_in",
        "polyphony": "poly_from_input",
        "description": "Probe 5: generic measurement tap. Accepts any signal; channel count follows the patched cable."
      },
      {
        "portId": 5,
        "role": "unknown",
        "key": "probe_6_in",
        "polyphony": "poly_from_input",
        "description": "Probe 6: generic measurement tap. Accepts any signal; channel count follows the patched cable."
      },
      {
        "portId": 6,
        "role": "unknown",
        "key": "probe_7_in",
        "polyphony": "poly_from_input",
        "description": "Probe 7: generic measurement tap. Accepts any signal; channel count follows the patched cable."
      },
      {
        "portId": 7,
        "role": "unknown",
        "key": "probe_8_in",
        "polyphony": "poly_from_input",
        "description": "Probe 8: generic measurement tap. Accepts any signal; channel count follows the patched cable."
      }
    ],
    "outputs": [],
    "polyphony": "poly_from_input",
    "opaqueStateFields": [],
    "validationRules": [],
    "connectionRecipes": [],
    "provenance": [
      "inspect_model on VCV Rack 2.6.6 (Core) / Fundamental 2.6.4; port and parameter ids/names verified: 8 inputs 'Probe 1'..'Probe 8' (portId 0-7), zero params, zero outputs.",
      "Semantics cross-checked against plugins/RackMCP/src/rackside/ProbeModule.cpp: ProbeModule::process() reads input.getChannels()/getVoltage() and accumulates per-channel window statistics (poly_from_input); configInput registers each port as a bare 'Probe N' with no committed signal role, so role=unknown; no outputs and no parameters exist, so no connection recipes originate from this module.",
      "pluginVersionRange corrected from '>=0.1.0 <1.0.0' to '>=2.0.0 <3.0.0' to include the plugin's actual version: plugins/RackMCP/plugin.json declares version '2.0.0' (VCV Rack plugin version reported by inspect_model). The prior 0.1.0 came from the monorepo/protocol package, not the VCV plugin."
    ]
  }
];
