import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Wind, Volume2, VolumeX, Leaf } from "lucide-react";
import "./styles.css";

const LEAF_COLORS = ["#2f7d42", "#4e9b4c", "#79b85a", "#a7c95b", "#d2a94b", "#e1a34a"];
const random = (min, max) => min + Math.random() * (max - min);

function LeafCanvas({ intensity }) {
  const canvasRef = useRef(null);
  const intensityRef = useRef(intensity);
  useEffect(() => { intensityRef.current = intensity; }, [intensity]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    let width = 0, height = 0, raf = 0, last = 0;
    let leaves = [];
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth; height = window.innerHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.round(Math.min(100, Math.max(42, width / 12)));
      leaves = Array.from({ length: count }, () => makeLeaf(true));
    };
    const makeLeaf = (initial = false) => ({
      x: random(-30, width + 30), y: initial ? random(-height, height) : random(-100, -20),
      size: random(5, 13), speed: random(20, 66), drift: random(10, 48),
      phase: random(0, Math.PI * 2), spin: random(-2.8, 2.8),
      rotation: random(0, Math.PI * 2), color: LEAF_COLORS[Math.floor(random(0, LEAF_COLORS.length))],
      sway: random(0.7, 1.8)
    });
    const drawLeaf = (leaf) => {
      ctx.save();
      ctx.translate(leaf.x, leaf.y);
      ctx.rotate(leaf.rotation);
      ctx.scale(1, 0.72);
      ctx.fillStyle = leaf.color;
      ctx.beginPath();
      ctx.moveTo(0, -leaf.size);
      ctx.quadraticCurveTo(leaf.size * 1.12, -leaf.size * .35, 0, leaf.size);
      ctx.quadraticCurveTo(-leaf.size * 1.12, -leaf.size * .35, 0, -leaf.size);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,.42)";
      ctx.lineWidth = .65;
      ctx.beginPath(); ctx.moveTo(0, -leaf.size * .68); ctx.lineTo(0, leaf.size * .7); ctx.stroke();
      ctx.restore();
    };
    const frame = (time) => {
      const dt = Math.min((time - (last || time)) / 1000, .04);
      last = time;
      ctx.clearRect(0, 0, width, height);
      const breeze = intensityRef.current;
      for (const leaf of leaves) {
        leaf.phase += dt * leaf.sway;
        leaf.x += (Math.sin(leaf.phase) * leaf.drift + 28 + breeze * 82) * dt;
        leaf.y += leaf.speed * (0.65 + breeze * .35) * dt;
        leaf.rotation += leaf.spin * dt * (0.55 + breeze);
        if (leaf.y > height + 35 || leaf.x > width + 40) {
          Object.assign(leaf, makeLeaf(false));
          if (Math.random() > .5) leaf.x = random(-90, -10);
        }
        drawLeaf(leaf);
      }
      raf = requestAnimationFrame(frame);
    };
    resize();
    window.addEventListener("resize", resize);
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", resize); };
  }, []);
  return <canvas className="leaf-canvas" ref={canvasRef} aria-hidden="true" />;
}

function Tree() {
  return (
    <svg className="tree-art" viewBox="0 0 520 720" role="img" aria-label="A leafy green tree moving gently in the breeze">
      <defs>
        <linearGradient id="trunk" x1="0" x2="1">
          <stop offset="0" stopColor="#503d27"/><stop offset=".5" stopColor="#795536"/><stop offset="1" stopColor="#392f20"/>
        </linearGradient>
        <linearGradient id="leafGreen" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8fca68"/><stop offset=".48" stopColor="#3f963f"/><stop offset="1" stopColor="#17683b"/>
        </linearGradient>
        <filter id="soft"><feGaussianBlur stdDeviation="1.2"/></filter>
      </defs>
      <ellipse cx="235" cy="678" rx="180" ry="18" fill="#5d7d3b" opacity=".16"/>
      <g className="branches" fill="none" stroke="url(#trunk)" strokeLinecap="round">
        <path d="M218 685 C208 583 231 500 222 413 C214 335 172 272 127 215" strokeWidth="24"/>
        <path d="M222 481 C260 408 307 357 361 318 C395 294 414 270 431 238" strokeWidth="14"/>
        <path d="M221 407 C173 367 121 338 79 294 C57 271 44 245 37 219" strokeWidth="12"/>
        <path d="M227 335 C257 271 274 221 279 161 C281 126 271 93 258 64" strokeWidth="11"/>
        <path d="M266 393 C324 388 367 400 415 427" strokeWidth="8"/>
        <path d="M166 330 C161 275 172 230 196 184" strokeWidth="7"/>
        <path d="M315 354 C339 298 345 256 337 208" strokeWidth="7"/>
        <path d="M111 306 C96 263 98 228 109 192" strokeWidth="6"/>
        <path d="M279 210 C311 180 339 155 358 121" strokeWidth="5"/>
      </g>
      <g className="canopy">
        {Array.from({ length: 130 }, (_, i) => {
          const angle = i * 2.39996;
          const r = Math.sqrt((i + 1) / 130);
          const x = 232 + Math.cos(angle) * 185 * r;
          const y = 235 + Math.sin(angle) * 176 * r;
          const rx = 23 + (i % 5) * 3;
          const ry = 19 + (i % 4) * 3;
          return <ellipse key={i} cx={x} cy={y} rx={rx} ry={ry} fill={i % 7 === 0 ? "#a3d578" : i % 4 === 0 ? "#2b803d" : "url(#leafGreen)"} opacity={.62 + (i % 5) * .07} transform={`rotate(${(i * 19) % 65 - 30} ${x} ${y})`} />;
        })}
        {Array.from({ length: 85 }, (_, i) => {
          const angle = i * 2.4, r = Math.sqrt((i + 1) / 85);
          const x = 230 + Math.cos(angle) * 162 * r, y = 225 + Math.sin(angle) * 153 * r;
          return <ellipse key={`l${i}`} cx={x} cy={y} rx={randomLeaf(i)} ry={randomLeaf(i + 4)} fill={["#6ebc54", "#2e8c43", "#b0d978", "#398b3a"][i % 4]} opacity=".8" transform={`rotate(${i * 37 % 90} ${x} ${y})`} />;
        })}
      </g>
      <g fill="none" stroke="#4b7033" strokeWidth="2" opacity=".5">
        <path d="M75 240 Q125 170 177 164 T270 115"/><path d="M121 286 Q179 245 205 194 T246 130"/>
        <path d="M250 270 Q310 205 347 190 T402 147"/><path d="M270 323 Q329 278 370 276 T421 248"/>
      </g>
    </svg>
  );
}
function randomLeaf(seed) { return 8 + ((seed * 17) % 11); }

function App() {
  const [breeze, setBreeze] = useState(0.55);
  const [showText, setShowText] = useState(true);
  return (
    <main className="scene">
      <div className="sky-glow" />
      <div className="sun" />
      <div className="distant-hills"><span /><span /><span /></div>
      <div className="light-rays" />
      <LeafCanvas intensity={breeze} />
      <div className="tree-wrap"><Tree /></div>
      <div className="meadow">
        {Array.from({ length: 90 }, (_, i) => <i key={i} style={{ left: `${i * 1.13}%`, height: `${12 + (i * 19) % 40}px`, animationDelay: `${(i % 13) * -.21}s`, transform: `rotate(${(i % 2 ? 1 : -1) * (8 + i % 24)}deg)` }} />)}
      </div>
      {showText && <section className="intro">
        <div className="eyebrow"><Leaf size={15} /> A LITTLE MOMENT OF NATURE</div>
        <h1>Where the wind<br /><em>whispers green.</em></h1>
        <p>Take a breath. Let the leaves drift, the branches sway, and the world slow down.</p>
        <button className="wind-button" onClick={() => setBreeze(v => v > .8 ? .15 : v + .35)}>
          <Wind size={17} /> {breeze > .8 ? "Gentle breeze" : breeze < .3 ? "Bring the wind" : "Feel the wind"}
        </button>
      </section>}
      <div className="controls">
        <button aria-label={showText ? "Hide text" : "Show text"} title={showText ? "Hide text" : "Show text"} onClick={() => setShowText(v => !v)}><Leaf size={17} /></button>
        <span className="control-divider" />
        <button aria-label="Toggle breeze intensity" title="Toggle breeze intensity" onClick={() => setBreeze(v => v > .75 ? .25 : .95)}><Wind size={17} /></button>
      </div>
      <div className="signature">BREATHE IN <span>·</span> BREATHE OUT</div>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
