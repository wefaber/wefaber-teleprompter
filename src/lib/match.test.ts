import { describe, expect, test } from "bun:test";
import DEFAULT_SCRIPT from "./default-script.md" with { type: "text" };
import { Tracker, stem, words } from "./match";
import { parseScript } from "./script";

const SCRIPT = `
# Búsqueda
## Filtros
claves: filtros, rubro, departamento
- Rubro, departamento y jornada
- Presencial, remoto o híbrido

## Primer empleo
claves: primer empleo, experiencia
- Marca de sin experiencia
- Pensado para quien arranca

# Mercado
## Sueldos
claves: sueldos, mercado, salario
- Sueldos medios por puesto
- Qué se pide más

## Habilidades
claves: habilidades, mediana
- Cada una con la mediana de lo que pagan
`;

describe("parseScript", () => {
  test("arma secciones, puntos, claves y notas", () => {
    const doc = parseScript(SCRIPT + "\nnota: ojo con esto\n");
    expect(doc.sections.map((s) => s.title)).toEqual(["Búsqueda", "Mercado"]);
    expect(doc.points.map((p) => p.title)).toEqual(["Filtros", "Primer empleo", "Sueldos", "Habilidades"]);
    expect(doc.points[0]?.keys).toEqual(["filtros", "rubro", "departamento"]);
    expect(doc.points[3]?.notes).toEqual(["ojo con esto"]);
    expect(doc.sections[1]).toMatchObject({ first: 2, last: 3 });
  });

  test("una viñeta suelta arma un punto con el nombre de la sección", () => {
    const doc = parseScript("# Intro\n- hola");
    expect(doc.points[0]?.title).toBe("Intro");
  });
});

describe("words / stem", () => {
  test("saca tildes y signos", () => {
    expect(words("¡Búsqueda, rápida!")).toEqual(["busqueda", "rapida"]);
  });
  test("plurales y género coinciden", () => {
    expect(stem("filtros")).toBe(stem("filtro"));
    expect(stem("empresas")).toBe(stem("empresa"));
  });
});

describe("Tracker", () => {
  const doc = parseScript(SCRIPT);

  test("tacha viñetas del punto actual", () => {
    const t = new Tracker(doc);
    const s = t.final("tenés filtros por rubro y por departamento", 1_000);
    expect(s.index).toBe(0);
    expect(s.covered.has(0)).toBe(true);
    expect(s.covered.has(1)).toBe(false);
  });

  test("pasa al siguiente cuando se habla de él", () => {
    const t = new Tracker(doc);
    t.final("los filtros por rubro y departamento", 1_000);
    const s = t.final("y si es tu primer empleo marcás sin experiencia", 5_000);
    expect(s.index).toBe(1);
  });

  test("no salta antes del tiempo mínimo", () => {
    const t = new Tracker(doc);
    const s = t.final("primer empleo sin experiencia", 1_000);
    expect(s.index).toBe(0);
  });

  test("saltearse un punto pide dos frases que coincidan", () => {
    const t = new Tracker(doc);
    t.final("filtros de rubro", 1_000);
    expect(t.final("el mercado: sueldos medios, cuánto es el salario por puesto", 6_000).index).toBe(0);
    expect(t.final("los sueldos del mercado, el salario medio de cada puesto", 9_000).index).toBe(2);
  });

  test("una mención suelta de otra sección no cambia de sección", () => {
    const t = new Tracker(doc);
    t.final("filtros de rubro", 1_000);
    t.final("el mercado: sueldos medios, cuánto es el salario por puesto", 6_000);
    // Vuelve a lo suyo: el voto queda solo y vence.
    const s = t.final("rubro, departamento, jornada, presencial o remoto", 9_000);
    expect(s.index).toBe(0);
    expect(t.final("los sueldos del mercado, el salario medio de cada puesto", 30_000).index).toBe(0);
  });

  test("no vuelve atrás más de un punto", () => {
    const t = new Tracker(doc);
    t.jump(3, 0);
    t.final("filtros por rubro y departamento, jornada presencial remoto", 5_000);
    const s = t.final("filtros de rubro, departamento, jornada, presencial, remoto, híbrido", 8_000);
    expect(s.index).toBe(3);
  });

  test("pasar a la sección siguiente pide confirmación si el punto no se terminó", () => {
    const t = new Tracker(doc);
    t.jump(1, 0);
    expect(t.final("sueldos del mercado y el salario", 5_000).index).toBe(1);
    expect(t.final("el mercado, sueldos medios por puesto", 8_000).index).toBe(2);
  });

  test("con el punto dicho entero pasa de sección con una frase", () => {
    const t = new Tracker(doc);
    t.jump(1, 0);
    t.final("es una marca de sin experiencia, pensado para quien arranca", 1_000);
    expect(t.final("ahora el mercado: los sueldos medios por puesto", 5_000).index).toBe(2);
  });

  test("hablar del punto actual no lo hace saltar", () => {
    const t = new Tracker(doc);
    t.final("filtros por rubro", 1_000);
    const s = t.final("rubro, departamento, jornada, presencial, remoto, híbrido", 6_000);
    expect(s.index).toBe(0);
  });

  test("nombrar una sección lejana salta ahí si hay evidencia clara", () => {
    const big = parseScript(
      SCRIPT +
        `
# Relleno
## Uno
- alfa beta
## Dos
- gamma delta
# Privacidad
## Buscar sin cuenta
claves: sin cuenta, navegador, registro
- Todo vive en tu navegador
`,
    );
    const t = new Tracker(big);
    t.final("filtros por rubro", 1_000);
    t.final("ahora la privacidad: buscás sin cuenta, todo en tu navegador, sin registro", 6_000);
    const s = t.final("sin registro y sin cuenta: vive en tu navegador", 9_000);
    expect(big.points[s.index]?.title).toBe("Buscar sin cuenta");
  });

  test("una palabra suelta de un punto lejano no hace saltar", () => {
    const t = new Tracker(doc);
    t.final("filtros por rubro", 1_000);
    const s = t.final("y eso también sirve para ver habilidades", 6_000);
    expect(s.index).toBe(0);
  });

  test("en manual no avanza solo", () => {
    const t = new Tracker(doc, { sensitivity: "media", auto: false, windowMs: 14_000, minDwellMs: 2_500 });
    t.final("filtros", 1_000);
    const s = t.final("primer empleo sin experiencia", 6_000);
    expect(s.index).toBe(0);
  });

  test("un salto a mano descarta lo dicho antes", () => {
    const t = new Tracker(doc);
    t.final("sueldos mercado salario", 1_000);
    t.jump(1, 2_000);
    const s = t.final("nada que ver", 6_000);
    expect(s.index).toBe(1);
  });
});

describe("charla con el guion de ejemplo", () => {
  // Frases como salen al hablar, cada ~3 s. Cada una con el punto esperado.
  const TALK: [string, string][] = [
    ["bueno, hoy si querés buscar trabajo tenés que entrar a cinco portales distintos", "Gancho"],
    ["y en cada uno te hacés una cuenta, y tus datos quedan por todos lados", "Gancho"],
    ["entonces JobIt junta todo eso y ni siquiera te pide el mail", "Gancho"],
    ["les cuento qué es JobIt, es un buscador de trabajo de acá de Uruguay, de todos los rubros", "Qué son JobIt y LearnIt"],
    ["y LearnIt es la parte de aprender, hoy con idiomas", "Qué son JobIt y LearnIt"],
    ["en este video les voy a mostrar las funciones principales y el roadmap", "De qué va el video"],
    // Cambiar de sección con el punto a medias se confirma con la frase siguiente.
    ["arranquemos con el tablero, que junta las fuentes: BuscoJobs, Uruguay Concursa", "De qué va el video"],
    ["y siempre te manda al aviso original", "Todo el mercado en un tablero"],
    ["después tenés filtros, por rubro, por departamento, por jornada", "Filtros"],
    ["y si estás buscando tu primer empleo, hay una marca de sin experiencia", "Primer empleo"],
    // Los saltos largos se confirman con la frase siguiente.
    ["ahora, algo importante es la privacidad, podés buscar sin cuenta, todo queda en tu navegador", "Primer empleo"],
    ["no te tenés que registrar, sin cuenta, lo tuyo vive en el navegador", "Buscar sin cuenta"],
    ["y del mercado, ves los sueldos medios por puesto y qué puestos se piden", "Buscar sin cuenta"],
    ["el mercado en números: sueldos, salario medio, los puestos con más demanda", "El mercado en números"],
    ["y algo que viene es el MCP, que tu agente de IA busque ofertas por vos", "El mercado en números"],
    ["con el MCP tu agente busca automatizado contra tu memoria", "MCP: tu agente busca por vos"],
  ];

  test("sigue la charla, incluidos los saltos", () => {
    const doc = parseScript(DEFAULT_SCRIPT);
    const t = new Tracker(doc, { sensitivity: "media", auto: true, windowMs: 12_000, minDwellMs: 2_500 });
    const got: string[] = [];
    TALK.forEach(([phrase], i) => got.push(doc.points[t.final(phrase, 3_000 + i * 3_200).index]!.title));
    expect(got).toEqual(TALK.map(([, title]) => title));
  });
});

describe("Tracker con ayuda de afuera", () => {
  const doc = parseScript(SCRIPT);

  test("propose al siguiente de la misma sección salta de una", () => {
    const t = new Tracker(doc);
    expect(t.propose(1, 5_000).index).toBe(1);
    expect(t.cover([1, 9]).covered).toEqual(new Set([1]));
  });

  test("propose más lejos necesita que una frase coincida", () => {
    const t = new Tracker(doc);
    expect(t.propose(2, 5_000).index).toBe(0);
    expect(t.final("sueldos del mercado, salario por puesto", 7_000).index).toBe(2);
  });

  test("propose ignora saltos largos o hacia atrás", () => {
    const t = new Tracker(doc);
    t.jump(3, 0);
    expect(t.propose(0, 5_000).index).toBe(3);
    expect(t.propose(0, 8_000).index).toBe(3);
  });

  test("después de un salto no vuelve a saltar enseguida", () => {
    const t = new Tracker(doc);
    t.propose(1, 5_000);
    expect(t.propose(2, 6_000).index).toBe(1);
  });
});
