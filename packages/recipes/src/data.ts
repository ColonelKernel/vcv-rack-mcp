import type { PatchOperation, Recipe, SignalRole } from "@rackmcp/schemas";

/**
 * The eight required high-level recipes (spec section 11).
 *
 * Roles are bound to installed models at resolution time; operation templates
 * reference roles with the placeholder pluginSlug "$role" and modelSlug set to
 * the role key (see @rackmcp/recipes expandRecipeOperations). Every port id and
 * parameter id used below is taken from verified `inspect_model` ground truth
 * and is cross-checked against the adapter pack by the recipes unit test, so a
 * typo cannot silently produce a mis-wired patch.
 *
 * Parameters are set with normalized [0..1] targets for portability across the
 * differing raw units of each model.
 */

// ---- typed authoring helpers (tsc checks every field against PatchOperation) --

/** Add a module bound to a recipe role (resolved to a concrete model later). */
function addRole(roleKey: string, alias: string): PatchOperation {
  return { op: "add_module", pluginSlug: "$role", modelSlug: roleKey, alias, placement: "auto" };
}

/** Set a parameter by normalized [0..1] value. */
function setNorm(alias: string, paramId: number, normalized: number): PatchOperation {
  return { op: "set_parameter", module: { alias }, paramId, normalized };
}

/** Connect an output port to an input port; fresh inputs use fail_if_connected. */
function connect(
  outAlias: string,
  outPort: number,
  inAlias: string,
  inPort: number,
): PatchOperation {
  return {
    op: "connect",
    output: { module: { alias: outAlias }, portType: "output", portId: outPort },
    input: { module: { alias: inAlias }, portType: "input", portId: inPort },
    inputPolicy: "fail_if_connected",
  };
}

interface RoleReq {
  role: string;
  description: string;
  preferred: { pluginSlug: string; modelSlug: string };
  adapterVerifiedAlternatives: Array<{ pluginSlug: string; modelSlug: string }>;
  signalRoles: SignalRole[];
}

/** Declare a functional role with its preferred concrete model. */
function need(
  role: string,
  description: string,
  pluginSlug: string,
  modelSlug: string,
  signalRoles: SignalRole[] = [],
): RoleReq {
  return {
    role,
    description,
    preferred: { pluginSlug, modelSlug },
    adapterVerifiedAlternatives: [],
    signalRoles,
  };
}

// Verified port ids (from inspect_model ground truth), named for readability.
const MIDI = { pitch: 0, gate: 1 };
const VCO = { pitchIn: 0, sawOut: 2 };
const VCF = { cutoffCv: 0, audioIn: 3, lpOut: 0, cutoffParam: 0, cutoffDepth: 3 };
const VCA = { gainCv: 0, audioIn: 1, audioOut: 0, level: 0 };
const ADSR = { gateIn: 4, envOut: 0, attack: 0, decay: 1, sustain: 2, release: 3 };
const LFO = { freq: 2, sineOut: 0, squareOut: 3 };
const AUDIO = { in1: 0, in2: 1 };
const SEQ = { clockIn: 1, trigOut: 0, cv1Out: 1, stepsParam: 3, tempoParam: 0 };
const DELAY = { audioIn: 4, mixOut: 0, wetOut: 1, timeParam: 0, feedbackParam: 1, mixParam: 3 };
const PROBE = { p1: 0, p2: 1, p3: 2 };

// -----------------------------------------------------------------------------

const R1_basicMono: Recipe = {
  recipeVersion: 1,
  id: "basic_mono_subtractive",
  name: "Basic monophonic subtractive voice",
  description:
    "A classic single-voice subtractive synthesizer: a MIDI keyboard drives one oscillator through a low-pass filter and an amplifier, with an ADSR envelope shaping the amplitude. The final signal is routed to the audio output. This is the canonical starting point for building and learning synth patches.",
  roles: [
    need("midi_input", "Note/gate source for the voice.", "Core", "MIDIToCVInterface", ["pitch_voct", "gate"]),
    need("oscillator", "Primary tone generator (pitched by the MIDI CV).", "Fundamental", "VCO", ["audio"]),
    need("filter", "Low-pass filter that shapes timbre.", "Fundamental", "VCF", ["audio"]),
    need("envelope", "ADSR envelope controlling amplitude over time.", "Fundamental", "ADSR", ["cv_unipolar"]),
    need("amplifier", "Voltage-controlled amplifier gating the voice by the envelope.", "Fundamental", "VCA-1", ["audio"]),
    need("audio_output", "Final audio sink to the sound device.", "Core", "AudioInterface2", ["audio"]),
  ],
  operations: [
    addRole("midi_input", "midi"),
    addRole("oscillator", "vco"),
    addRole("filter", "vcf"),
    addRole("envelope", "env"),
    addRole("amplifier", "vca"),
    addRole("audio_output", "audio"),
    setNorm("vcf", VCF.cutoffParam, 0.55),
    setNorm("env", ADSR.attack, 0.05),
    setNorm("env", ADSR.decay, 0.4),
    setNorm("env", ADSR.sustain, 0.7),
    setNorm("env", ADSR.release, 0.35),
    setNorm("vca", VCA.level, 1.0),
    connect("midi", MIDI.pitch, "vco", VCO.pitchIn),
    connect("midi", MIDI.gate, "env", ADSR.gateIn),
    connect("vco", VCO.sawOut, "vcf", VCF.audioIn),
    connect("env", ADSR.envOut, "vca", VCA.gainCv),
    connect("vcf", VCF.lpOut, "vca", VCA.audioIn),
    connect("vca", VCA.audioOut, "audio", AUDIO.in1),
    connect("vca", VCA.audioOut, "audio", AUDIO.in2),
  ],
  notes: [
    "The VCA level starts at unity so the envelope's CV fully controls the amplitude.",
    "Play a note on the configured MIDI device to hear the voice; adjust the VCF cutoff to taste.",
  ],
};

const R2_polyMono: Recipe = {
  recipeVersion: 1,
  id: "poly_midi_subtractive",
  name: "Polyphonic MIDI subtractive voice",
  description:
    "The subtractive voice built for polyphony: the same MIDI to CV, oscillator, filter, envelope and amplifier chain, driven by a polyphonic MIDI to CV interface so several notes sound at once. VCV cables carry all voice channels, so the single chain becomes N independent voices; the audio output sums the polyphonic signal automatically.",
  roles: [
    need("midi_input", "Polyphonic note/gate source (set channel count in its context menu).", "Core", "MIDIToCVInterface", ["pitch_voct", "gate"]),
    need("oscillator", "Oscillator; runs one instance per polyphony channel.", "Fundamental", "VCO", ["audio"]),
    need("filter", "Low-pass filter (polyphonic).", "Fundamental", "VCF", ["audio"]),
    need("envelope", "Per-voice ADSR envelope (polyphonic from the gate).", "Fundamental", "ADSR", ["cv_unipolar"]),
    need("amplifier", "Per-voice VCA gated by the envelope.", "Fundamental", "VCA-1", ["audio"]),
    need("audio_output", "Audio sink; sums polyphony channels to the device.", "Core", "AudioInterface2", ["audio"]),
  ],
  operations: [
    addRole("midi_input", "midi"),
    addRole("oscillator", "vco"),
    addRole("filter", "vcf"),
    addRole("envelope", "env"),
    addRole("amplifier", "vca"),
    addRole("audio_output", "audio"),
    setNorm("vcf", VCF.cutoffParam, 0.55),
    setNorm("env", ADSR.attack, 0.05),
    setNorm("env", ADSR.decay, 0.4),
    setNorm("env", ADSR.sustain, 0.7),
    setNorm("env", ADSR.release, 0.35),
    setNorm("vca", VCA.level, 1.0),
    connect("midi", MIDI.pitch, "vco", VCO.pitchIn),
    connect("midi", MIDI.gate, "env", ADSR.gateIn),
    connect("vco", VCO.sawOut, "vcf", VCF.audioIn),
    connect("env", ADSR.envOut, "vca", VCA.gainCv),
    connect("vcf", VCF.lpOut, "vca", VCA.audioIn),
    connect("vca", VCA.audioOut, "audio", AUDIO.in1),
    connect("vca", VCA.audioOut, "audio", AUDIO.in2),
  ],
  notes: [
    "Set the MIDI to CV polyphony channel count in its right-click context menu; that field is opaque module state and is not adjusted by this recipe.",
    "All downstream modules inherit polyphony from the cables automatically; no per-voice duplication is needed.",
  ],
};

const R3_clockedSeq: Recipe = {
  recipeVersion: 1,
  id: "clocked_8_step_sequence",
  name: "Clocked 8-step sequence",
  description:
    "An LFO clocks an 8-step sequencer whose CV row sets the oscillator pitch and whose trigger fires the envelope each step. The voice runs through a filter and amplifier to the audio output, producing an evolving looped melody without a keyboard.",
  roles: [
    need("clock", "Clock source (LFO square wave) advancing the sequencer.", "Fundamental", "LFO", ["clock"]),
    need("sequencer", "8-step CV/gate sequencer.", "Fundamental", "SEQ3", ["cv_bipolar", "trigger"]),
    need("oscillator", "Oscillator pitched by the sequencer CV.", "Fundamental", "VCO", ["audio"]),
    need("envelope", "ADSR fired by each step trigger.", "Fundamental", "ADSR", ["cv_unipolar"]),
    need("filter", "Low-pass filter.", "Fundamental", "VCF", ["audio"]),
    need("amplifier", "VCA gated by the envelope.", "Fundamental", "VCA-1", ["audio"]),
    need("audio_output", "Audio sink.", "Core", "AudioInterface2", ["audio"]),
  ],
  operations: [
    addRole("clock", "clk"),
    addRole("sequencer", "seq"),
    addRole("oscillator", "vco"),
    addRole("envelope", "env"),
    addRole("filter", "vcf"),
    addRole("amplifier", "vca"),
    addRole("audio_output", "audio"),
    setNorm("clk", LFO.freq, 0.4),
    setNorm("seq", SEQ.stepsParam, 1.0),
    setNorm("vcf", VCF.cutoffParam, 0.5),
    setNorm("env", ADSR.attack, 0.02),
    setNorm("env", ADSR.decay, 0.3),
    setNorm("env", ADSR.sustain, 0.5),
    setNorm("env", ADSR.release, 0.2),
    setNorm("vca", VCA.level, 1.0),
    connect("clk", LFO.squareOut, "seq", SEQ.clockIn),
    connect("seq", SEQ.cv1Out, "vco", VCO.pitchIn),
    connect("seq", SEQ.trigOut, "env", ADSR.gateIn),
    connect("vco", VCO.sawOut, "vcf", VCF.audioIn),
    connect("env", ADSR.envOut, "vca", VCA.gainCv),
    connect("vcf", VCF.lpOut, "vca", VCA.audioIn),
    connect("vca", VCA.audioOut, "audio", AUDIO.in1),
    connect("vca", VCA.audioOut, "audio", AUDIO.in2),
  ],
  notes: [
    "Tune each step with the sequencer's CV1 row knobs; the CV is 1V/octave into the oscillator.",
    "The step trigger produces short plucks; patch a per-step gate output instead for sustained notes.",
    "Raise the LFO frequency for a faster tempo; the sequencer is set to 8 active steps.",
  ],
};

const R4_stereoDelay: Recipe = {
  recipeVersion: 1,
  id: "stereo_delay_send_return",
  name: "Stereo send/return delay",
  description:
    "A source is sent to two delay lines set to slightly different times, one panned to each output channel, creating a wide stereo echo. Each delay's mix and feedback act as the return level, so the dry/wet balance is controlled per side. Fundamental Delay is mono, so genuine stereo width uses one delay instance per channel.",
  roles: [
    need("source", "Sound source feeding the stereo delay bus.", "Fundamental", "VCO", ["audio"]),
    need("delay_left", "Left-channel delay line.", "Fundamental", "Delay", ["audio"]),
    need("delay_right", "Right-channel delay line (different time for width).", "Fundamental", "Delay", ["audio"]),
    need("audio_output", "Stereo audio sink.", "Core", "AudioInterface2", ["audio"]),
  ],
  operations: [
    addRole("source", "src"),
    addRole("delay_left", "delL"),
    addRole("delay_right", "delR"),
    addRole("audio_output", "audio"),
    setNorm("delL", DELAY.timeParam, 0.25),
    setNorm("delR", DELAY.timeParam, 0.45),
    setNorm("delL", DELAY.feedbackParam, 0.4),
    setNorm("delR", DELAY.feedbackParam, 0.4),
    setNorm("delL", DELAY.mixParam, 0.5),
    setNorm("delR", DELAY.mixParam, 0.5),
    connect("src", VCO.sawOut, "delL", DELAY.audioIn),
    connect("src", VCO.sawOut, "delR", DELAY.audioIn),
    connect("delL", DELAY.mixOut, "audio", AUDIO.in1),
    connect("delR", DELAY.mixOut, "audio", AUDIO.in2),
  ],
  notes: [
    "The two delay times differ to spread the echoes across the stereo field; nudge them for more or less width.",
    "Raise each delay's feedback for longer tails and the mix knob for a wetter return.",
  ],
};

const R5_safeMaster: Recipe = {
  recipeVersion: 1,
  id: "safe_master_output",
  name: "Safe master output",
  description:
    "A protective master stage placed before the audio device: your final mix passes through a VCA acting as a master fader set to leave headroom, then to the audio output at unity. This guards against accidental clipping at the interface. Patch your mix bus into the master VCA's audio input.",
  roles: [
    need("master_vca", "Master fader VCA before the audio device.", "Fundamental", "VCA-1", ["audio"]),
    need("audio_output", "Audio sink to the sound device.", "Core", "AudioInterface2", ["audio"]),
  ],
  operations: [
    addRole("master_vca", "master"),
    addRole("audio_output", "audio"),
    setNorm("master", VCA.level, 0.7),
    connect("master", VCA.audioOut, "audio", AUDIO.in1),
    connect("master", VCA.audioOut, "audio", AUDIO.in2),
  ],
  notes: [
    "Patch your final mix into the master VCA's audio input (input port 1).",
    "The master level starts at 0.7 for headroom; raise it carefully while watching the interface for clipping.",
    "The audio interface level stays at unity so the VCA is the single master control.",
  ],
};

const R6_lfoMod: Recipe = {
  recipeVersion: 1,
  id: "lfo_filter_modulation",
  name: "LFO filter modulation",
  description:
    "A slow LFO sweeps the filter cutoff of a running voice, producing an evolving, breathing timbre. The oscillator feeds the filter, the LFO modulates cutoff through the filter's CV input, and the amplifier passes the result to the output. The modulation depth is set by the filter's cutoff CV attenuverter.",
  roles: [
    need("source", "Oscillator tone source.", "Fundamental", "VCO", ["audio"]),
    need("lfo", "Low-frequency modulation source.", "Fundamental", "LFO", ["cv_bipolar"]),
    need("filter", "Low-pass filter whose cutoff is modulated.", "Fundamental", "VCF", ["audio"]),
    need("amplifier", "Output VCA.", "Fundamental", "VCA-1", ["audio"]),
    need("audio_output", "Audio sink.", "Core", "AudioInterface2", ["audio"]),
  ],
  operations: [
    addRole("source", "vco"),
    addRole("lfo", "lfo"),
    addRole("filter", "vcf"),
    addRole("amplifier", "vca"),
    addRole("audio_output", "audio"),
    setNorm("lfo", LFO.freq, 0.2),
    setNorm("vcf", VCF.cutoffParam, 0.5),
    setNorm("vcf", VCF.cutoffDepth, 0.5),
    setNorm("vca", VCA.level, 0.8),
    connect("vco", VCO.sawOut, "vcf", VCF.audioIn),
    connect("lfo", LFO.sineOut, "vcf", VCF.cutoffCv),
    connect("vcf", VCF.lpOut, "vca", VCA.audioIn),
    connect("vca", VCA.audioOut, "audio", AUDIO.in1),
    connect("vca", VCA.audioOut, "audio", AUDIO.in2),
  ],
  notes: [
    "The LFO sine wave sweeps the cutoff; set the sweep depth with the VCF cutoff CV attenuverter (parameter 3).",
    "Lower the LFO frequency for slow filter sweeps, raise it for tremolo-like motion.",
  ],
};

const R7_sidechain: Recipe = {
  recipeVersion: 1,
  id: "sidechain_envelope_follow",
  name: "Sidechain envelope amplitude control",
  description:
    "A trigger source drives an ADSR envelope that controls the amplitude of a separate signal through a VCA — the building block of sidechain dynamics. Each trigger raises the gain in a rhythmic swell synced to the sidechain source. True inverse ducking (gain dips on the trigger) needs an inverting offset stage that Fundamental does not provide directly.",
  roles: [
    need("main_source", "Main signal whose amplitude is modulated.", "Fundamental", "VCO", ["audio"]),
    need("trigger_source", "Sidechain trigger/gate source.", "Core", "MIDIToCVInterface", ["gate"]),
    need("envelope", "Envelope generating the gain contour.", "Fundamental", "ADSR", ["cv_unipolar"]),
    need("duck_vca", "VCA whose gain follows the envelope.", "Fundamental", "VCA-1", ["audio"]),
    need("audio_output", "Audio sink.", "Core", "AudioInterface2", ["audio"]),
  ],
  operations: [
    addRole("main_source", "src"),
    addRole("trigger_source", "trig"),
    addRole("envelope", "env"),
    addRole("duck_vca", "vca"),
    addRole("audio_output", "audio"),
    setNorm("env", ADSR.attack, 0.02),
    setNorm("env", ADSR.decay, 0.25),
    setNorm("env", ADSR.sustain, 0.0),
    setNorm("env", ADSR.release, 0.3),
    setNorm("vca", VCA.level, 1.0),
    connect("src", VCO.sawOut, "vca", VCA.audioIn),
    connect("trig", MIDI.gate, "env", ADSR.gateIn),
    connect("env", ADSR.envOut, "vca", VCA.gainCv),
    connect("vca", VCA.audioOut, "audio", AUDIO.in1),
    connect("vca", VCA.audioOut, "audio", AUDIO.in2),
  ],
  notes: [
    "Each trigger produces a plucked amplitude envelope (sustain is 0) synced to the sidechain source.",
    "For classic inverse ducking, invert the envelope with an 8vert channel plus a DC offset, or use a dedicated ducking module, then patch that into the VCA gain instead.",
  ],
};

const R8_probeDiag: Recipe = {
  recipeVersion: 1,
  id: "probe_silence_diagnosis",
  name: "Probe-assisted silence diagnosis",
  description:
    "The basic subtractive voice with a RackMCP Probe tapping the oscillator, filter and amplifier outputs. When a patch is unexpectedly silent, read the probe telemetry: the first tap reading roughly zero peak voltage marks where the signal stops, isolating the broken stage.",
  roles: [
    need("midi_input", "Note/gate source.", "Core", "MIDIToCVInterface", ["pitch_voct", "gate"]),
    need("oscillator", "Oscillator (tap 1).", "Fundamental", "VCO", ["audio"]),
    need("filter", "Filter (tap 2).", "Fundamental", "VCF", ["audio"]),
    need("envelope", "ADSR envelope.", "Fundamental", "ADSR", ["cv_unipolar"]),
    need("amplifier", "VCA (tap 3).", "Fundamental", "VCA-1", ["audio"]),
    need("audio_output", "Audio sink.", "Core", "AudioInterface2", ["audio"]),
    need("probe", "RackMCP Probe telemetry tap for diagnosis.", "RackMCP", "Probe", ["unknown"]),
  ],
  operations: [
    addRole("midi_input", "midi"),
    addRole("oscillator", "vco"),
    addRole("filter", "vcf"),
    addRole("envelope", "env"),
    addRole("amplifier", "vca"),
    addRole("audio_output", "audio"),
    addRole("probe", "probe"),
    setNorm("vcf", VCF.cutoffParam, 0.55),
    setNorm("env", ADSR.attack, 0.05),
    setNorm("env", ADSR.decay, 0.4),
    setNorm("env", ADSR.sustain, 0.7),
    setNorm("env", ADSR.release, 0.35),
    setNorm("vca", VCA.level, 1.0),
    connect("midi", MIDI.pitch, "vco", VCO.pitchIn),
    connect("midi", MIDI.gate, "env", ADSR.gateIn),
    connect("vco", VCO.sawOut, "vcf", VCF.audioIn),
    connect("env", ADSR.envOut, "vca", VCA.gainCv),
    connect("vcf", VCF.lpOut, "vca", VCA.audioIn),
    connect("vca", VCA.audioOut, "audio", AUDIO.in1),
    connect("vca", VCA.audioOut, "audio", AUDIO.in2),
    connect("vco", VCO.sawOut, "probe", PROBE.p1),
    connect("vcf", VCF.lpOut, "probe", PROBE.p2),
    connect("vca", VCA.audioOut, "probe", PROBE.p3),
  ],
  notes: [
    "After building, attach and read the probe: probe 1 = oscillator out, probe 2 = filter out, probe 3 = amplifier out.",
    "The first probe channel with a near-zero peak voltage marks the stage where the signal disappears.",
    "Telemetry requires the engine to be running (a note held); an idle engine reports zero on every tap.",
  ],
};

export const RECIPE_DOCS: ReadonlyArray<Recipe> = [
  R1_basicMono,
  R2_polyMono,
  R3_clockedSeq,
  R4_stereoDelay,
  R5_safeMaster,
  R6_lfoMod,
  R7_sidechain,
  R8_probeDiag,
];
