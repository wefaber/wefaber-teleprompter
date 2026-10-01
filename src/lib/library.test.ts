import { describe, expect, test } from "bun:test";
import { activeScript, add, nameOf, remove, select, uniqueName, update, type Library } from "./library";

const lib = (): Library => ({
  active: "a",
  scripts: [
    { id: "a", name: "Uno", text: "# Uno", updated: 0 },
    { id: "b", name: "Dos", text: "# Dos", updated: 0 },
    { id: "c", name: "Tres", text: "# Tres", updated: 0 },
  ],
});

describe("library", () => {
  test("el nombre sale de la primera sección", () => {
    expect(nameOf("intro\n# Gancho\n## Punto")).toBe("Gancho");
    expect(nameOf("## Solo punto")).toBe("Sin título");
  });

  test("sumar deja elegido el nuevo", () => {
    const l = add(lib(), "Cuatro", "# Cuatro", 1);
    expect(l.scripts).toHaveLength(4);
    expect(activeScript(l).name).toBe("Cuatro");
  });

  test("borrar el elegido pasa al de al lado y nunca deja la lista vacía", () => {
    let l = select(lib(), "b");
    l = remove(l, "b");
    expect(l.active).toBe("c");
    l = remove(l, "c");
    expect(l.active).toBe("a");
    expect(remove(l, "a")).toBe(l);
  });

  test("borrar otro no cambia el elegido", () => {
    expect(remove(lib(), "c").active).toBe("a");
  });

  test("editar toca solo ese guion", () => {
    const l = update(lib(), "b", { text: "# Otro" }, 5);
    expect(l.scripts[1]).toEqual({ id: "b", name: "Dos", text: "# Otro", updated: 5 });
    expect(l.scripts[0]!.updated).toBe(0);
  });

  test("elegir uno que no existe no hace nada", () => {
    expect(select(lib(), "x").active).toBe("a");
  });

  test("nombres sin repetir", () => {
    expect(uniqueName(lib(), "Uno")).toBe("Uno (2)");
    expect(uniqueName(lib(), "Cinco")).toBe("Cinco");
  });
});
