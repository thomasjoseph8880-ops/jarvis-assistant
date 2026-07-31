/* ---------------------------------------------------------------------
   J.A.R.V.I.S front end — Three.js holographic core + Web Speech API
--------------------------------------------------------------------- */

const CYAN = 0x4de8ff;
const AMBER = 0xffb14d;

const state = { listening: false, speaking: false };

// ---------------------------------------------------------------------
// Three.js holographic core
// ---------------------------------------------------------------------
const canvas = document.getElementById("core-canvas");
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, canvas.clientWidth / canvas.clientHeight, 0.1, 100);
camera.position.z = 6.2;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
function resizeRenderer() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
resizeRenderer();
window.addEventListener("resize", resizeRenderer);

// Particle sphere
const PARTICLE_COUNT = 2200;
const positions = new Float32Array(PARTICLE_COUNT * 3);
const basePositions = new Float32Array(PARTICLE_COUNT * 3);
for (let i = 0; i < PARTICLE_COUNT; i++) {
  const r = 1.9 + Math.random() * 0.15;
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.acos(2 * Math.random() - 1);
  const x = r * Math.sin(phi) * Math.cos(theta);
  const y = r * Math.sin(phi) * Math.sin(theta);
  const z = r * Math.cos(phi);
  positions.set([x, y, z], i * 3);
  basePositions.set([x, y, z], i * 3);
}
const geo = new THREE.BufferGeometry();
geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
const mat = new THREE.PointsMaterial({
  color: CYAN, size: 0.028, transparent: true, opacity: 0.85,
  blending: THREE.AdditiveBlending, depthWrite: false,
});
const particles = new THREE.Points(geo, mat);
scene.add(particles);

// HUD rings
const rings = [];
[
  { r: 2.4, tube: 0.006, color: CYAN, tilt: [1.3, 0.2, 0] },
  { r: 2.7, tube: 0.005, color: CYAN, tilt: [0.3, 1.1, 0.4] },
  { r: 3.05, tube: 0.004, color: AMBER, tilt: [1.7, 0.6, 1.0] },
].forEach((spec) => {
  const ringGeo = new THREE.TorusGeometry(spec.r, spec.tube, 8, 120, Math.PI * 1.4);
  const ringMat = new THREE.MeshBasicMaterial({ color: spec.color, transparent: true, opacity: 0.55 });
  const mesh = new THREE.Mesh(ringGeo, ringMat);
  mesh.rotation.set(...spec.tilt);
  scene.add(mesh);
  rings.push(mesh);
});

// Glow core
const core = new THREE.Mesh(
  new THREE.SphereGeometry(0.55, 32, 32),
  new THREE.MeshBasicMaterial({ color: CYAN, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending })
);
scene.add(core);

const clock = new THREE.Clock();
function animate() {
  const t = clock.getElapsedTime();
  const energy = state.listening ? 1.6 : state.speaking ? 1.1 : 0.5;

  particles.rotation.y = t * 0.06;
  particles.rotation.x = Math.sin(t * 0.05) * 0.1;

  const posAttr = geo.attributes.position;
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const idx = i * 3;
    const jitter = 1 + Math.sin(t * 2 + i) * 0.02 * energy * 0.06;
    posAttr.array[idx] = basePositions[idx] * jitter;
    posAttr.array[idx + 1] = basePositions[idx + 1] * jitter;
    posAttr.array[idx + 2] = basePositions[idx + 2] * jitter;
  }
  posAttr.needsUpdate = true;
  mat.size = 0.024 + energy * 0.012;

  rings.forEach((ring, i) => {
    ring.rotation.z += 0.0022 * (i + 1) * energy;
    ring.rotation.x += 0.0008 * (i + 1);
  });

  const pulse = 1 + Math.sin(t * (state.listening ? 6 : 2)) * (state.listening ? 0.12 : 0.04);
  core.scale.setScalar(pulse * (state.speaking ? 1.25 : 1));

  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
animate();

// ---------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------
const micBtn = null; // no manual mic button in always-listening mode
const statusLabel = document.getElementById("status-label");
const transcriptEl = document.getElementById("transcript");
const logEl = document.getElementById("log");

const WAKE_WORD = "jarvis";

function setStatus() {
  statusLabel.textContent = state.listening ? "LISTENING" : state.speaking ? "RESPONDING" : "STANDBY";
  statusLabel.classList.toggle("listening", state.listening);
}

function addLogEntry(role, text) {
  const div = document.createElement("div");
  div.className = "log-entry " + (role === "user" ? "user" : "");
  div.innerHTML = `<span class="who">${role === "user" ? "YOU" : "JARVIS"}</span>${text}`;
  logEl.appendChild(div);
  while (logEl.children.length > 6) logEl.removeChild(logEl.firstChild);
}

async function sendCommand(text) {
  addLogEntry("user", text);
  try {
    const res = await fetch("/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    const reply = data.reply || "No response.";
    addLogEntry("jarvis", reply);
    speak(reply);

    if (data.action && data.action.type === "open_url" && data.action.url) {
      window.open(data.action.url, "_blank");
    }
  } catch (err) {
    const msg = "I couldn't reach the backend. Is app.py running?";
    addLogEntry("jarvis", msg);
    speak(msg);
  }
}

// Pick a male-sounding system voice once the browser has loaded its voice
// list (this loads asynchronously, so we listen for the change event too).
let selectedVoice = null;
const MALE_HINTS = ["male", "david", "mark", "guy", "daniel", "george", "james", "alex", "fred", "ryan", "eric"];
const FEMALE_HINTS = ["female", "zira", "samantha", "susan", "victoria", "karen", "aria"];

function pickMaleVoice() {
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;

  const englishVoices = voices.filter((v) => v.lang.toLowerCase().startsWith("en"));
  const pool = englishVoices.length ? englishVoices : voices;

  let match = pool.find((v) => {
    const name = v.name.toLowerCase();
    return MALE_HINTS.some((h) => name.includes(h)) && !FEMALE_HINTS.some((h) => name.includes(h));
  });

  return match || pool[0] || voices[0];
}

function loadVoice() {
  selectedVoice = pickMaleVoice();
}
loadVoice();
if ("onvoiceschanged" in window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = loadVoice;
}

function speak(text) {
  state.speaking = true;
  pauseListening(); // don't let the mic hear Jarvis talking to itself
  setStatus();
  if (!("speechSynthesis" in window)) {
    setTimeout(() => { state.speaking = false; setStatus(); resumeListening(); }, 1400);
    return;
  }
  const utter = new SpeechSynthesisUtterance(text);
  if (selectedVoice) utter.voice = selectedVoice;
  utter.rate = 1.0;
  utter.pitch = 0.75; // lower pitch reinforces a male-leaning tone regardless of voice found
  utter.onend = () => {
    state.speaking = false;
    setStatus();
    resumeListening();
  };
  window.speechSynthesis.speak(utter);
}

// Speech recognition — always-listening mode
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let manuallyPaused = false; // true only while Jarvis itself is speaking

function pauseListening() {
  manuallyPaused = true;
  if (recognition) {
    try { recognition.stop(); } catch (e) { /* already stopped */ }
  }
}

function resumeListening() {
  manuallyPaused = false;
  startRecognition();
}

function startRecognition() {
  if (!recognition || manuallyPaused) return;
  try {
    recognition.start();
    state.listening = true;
    setStatus();
  } catch (e) {
    // start() throws if already running — safe to ignore
  }
}

function stripWakeWord(text) {
  const lower = text.trim().toLowerCase();
  if (lower.startsWith(WAKE_WORD)) {
    return text.trim().slice(WAKE_WORD.length).replace(/^[,.\s]+/, "");
  }
  return null;
}

if (SR) {
  recognition = new SR();
  recognition.lang = "en-US";
  recognition.interimResults = true;
  recognition.continuous = true;

  recognition.onresult = (e) => {
    const lastResult = e.results[e.results.length - 1];
    const text = lastResult[0].transcript;
    transcriptEl.textContent = text;

    if (lastResult.isFinal) {
      const command = stripWakeWord(text);
      transcriptEl.textContent = "";
      if (command !== null && command.length > 0) {
        sendCommand(command);
      }
      // If no wake word was heard, we just keep listening silently —
      // this is what prevents random background chatter from triggering it.
    }
  };

  recognition.onerror = (e) => {
    // "no-speech" and "aborted" fire constantly in always-on mode — not real errors.
    state.listening = false;
    setStatus();
  };

  // Browsers auto-stop recognition after a pause — restart it to stay always-on,
  // unless we deliberately paused it because Jarvis is speaking.
  recognition.onend = () => {
    state.listening = false;
    setStatus();
    if (!manuallyPaused) {
      setTimeout(startRecognition, 300);
    }
  };

  startRecognition();
} else {
  transcriptEl.textContent = "voice input unsupported in this browser — try Chrome or Edge";
}
