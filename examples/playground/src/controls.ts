// Renders one param control per module instance in the active patch, driven
// entirely by the public surface: getModuleDefinition() for the module's
// ParamSpec shape, and the curve helpers for the 0..1 slider position <->
// engine-unit value mapping a real module panel would do. "positions" params
// (switches) render as a <select> of their labels instead of a slider.

import {
  defaultNormalizedValue,
  engineValueToNormalized,
  getModuleDefinition,
  isBipolarParam,
  normalizedToEngineValue,
  type Engine,
  type ParamSpec,
  type Patch,
} from "patchatlas-audio";

function controlRow(
  name: string,
  spec: ParamSpec,
  initialEngineValue: number | undefined,
  onChange: (engineValue: number) => void,
): HTMLElement {
  const row = document.createElement("label");
  row.className = "control-row";

  const labelText = document.createElement("span");
  labelText.className = "control-label";
  labelText.textContent = name;
  row.appendChild(labelText);

  if (spec.curve === "positions" && spec.positions) {
    const select = document.createElement("select");
    spec.positions.forEach((positionLabel, index) => {
      const opt = document.createElement("option");
      opt.value = String(index);
      opt.textContent = positionLabel;
      select.appendChild(opt);
    });
    select.value = String(Math.round(initialEngineValue ?? spec.default));
    select.addEventListener("change", () => {
      onChange(normalizedToEngineValue(spec, Number(select.value)));
    });
    row.appendChild(select);
    return row;
  }

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "1";
  slider.step = "0.001";
  slider.value = String(
    initialEngineValue !== undefined
      ? engineValueToNormalized(spec, initialEngineValue)
      : defaultNormalizedValue(spec),
  );
  if (isBipolarParam(spec)) slider.classList.add("bipolar");
  slider.addEventListener("input", () => {
    onChange(normalizedToEngineValue(spec, Number(slider.value)));
  });
  row.appendChild(slider);
  return row;
}

export function renderControls(container: HTMLElement, patch: Patch, engine: Engine): void {
  container.replaceChildren();
  for (const mod of patch.modules) {
    const definition = getModuleDefinition(mod.type);
    const paramNames = definition ? Object.keys(definition.params) : [];
    if (paramNames.length === 0) continue;

    const group = document.createElement("fieldset");
    group.className = "module-controls";
    const legend = document.createElement("legend");
    legend.textContent = `${mod.id} — ${mod.type}`;
    group.appendChild(legend);

    for (const name of paramNames) {
      const spec = definition!.params[name];
      group.appendChild(
        controlRow(name, spec, mod.params?.[name], (engineValue) => {
          engine.setParam(mod.id, name, engineValue);
        }),
      );
    }
    container.appendChild(group);
  }
}
