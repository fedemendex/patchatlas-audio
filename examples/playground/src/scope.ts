// A minimal canvas oscilloscope over a host-owned AnalyserNode -- the
// playground creates and connects the analyser (routing, including analysers,
// is host territory, never the engine's), this module only draws what it
// reports. No charting dependency.

export function startScope(canvas: HTMLCanvasElement, analyser: AnalyserNode): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d canvas context unavailable");
  const buf = new Float32Array(analyser.fftSize);
  let raf = 0;

  function draw(): void {
    analyser.getFloatTimeDomainData(buf);
    const { width, height } = canvas;
    ctx!.clearRect(0, 0, width, height);
    ctx!.strokeStyle = "#4ade80";
    ctx!.lineWidth = 1.5;
    ctx!.beginPath();
    for (let i = 0; i < buf.length; i++) {
      const x = (i / (buf.length - 1)) * width;
      const y = height / 2 - buf[i] * (height / 2 - 2);
      if (i === 0) ctx!.moveTo(x, y);
      else ctx!.lineTo(x, y);
    }
    ctx!.stroke();
    raf = requestAnimationFrame(draw);
  }
  raf = requestAnimationFrame(draw);

  return () => cancelAnimationFrame(raf);
}
