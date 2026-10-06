import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { EMPTY_PROJECT_CONTEXT, type ProjectContext } from "../../src/infra/db/schema";
import {
    assertRepoPathSafe,
    readOptionalRepoFile,
    readRepoFile,
    UnsafeRepoPathError,
    writeRepoFile,
} from "../../src/core/repo/safe-fs";
import { humanizeSlug, slugify, uniqueSlug } from "../../src/core/repo/slug";
import {
    parseContextYaml,
    parseFeatureYaml,
    parseSpecYaml,
    parseYamlTitle,
    sameProjectContext,
    serializeContextYaml,
    serializeFeatureYaml,
    serializeSpecYaml,
    YamlParseError,
} from "../../src/core/repo/yaml";
import { tempDir } from "../helpers/storage";

describe("slug", () => {
    test("slugify strips accents, symbols and length", () => {
        assert.equal(slugify("Autenticação do Usuário!"), "autenticacao-do-usuario");
        assert.equal(slugify("  --Olá, Mundo--  "), "ola-mundo");
        assert.equal(slugify("???"), "untitled");
        const long = slugify("a".repeat(59) + " b c");
        assert.ok(long.length <= 60 && !long.endsWith("-"), long);
    });

    test("uniqueSlug suffixes the id only on collision", () => {
        assert.equal(uniqueSlug("Login", new Set(), "abcdef123"), "login");
        assert.equal(uniqueSlug("Login", new Set(["login"]), "abcdef123"), "login-abcdef");
    });

    test("humanizeSlug", () => {
        assert.equal(humanizeSlug("fluxo-de-login"), "Fluxo de login");
        assert.equal(humanizeSlug("---"), "Untitled");
    });
});

describe("yaml", () => {
    const humanSpec = {
        preconditions: ["Usuário cadastrado"],
        steps: ["Abrir a página", "Informar: e-mail #1"],
        expectedResult: "Painel exibido",
        postconditions: [],
    };

    test("spec.yml round-trips", () => {
        const yaml = serializeSpecYaml({ title: "Login: válido", description: "desc", humanSpec });
        assert.deepEqual(parseSpecYaml(yaml), { title: "Login: válido", description: "desc", humanSpec });
        assert.equal(parseYamlTitle(yaml), "Login: válido");
    });

    test("feature.yml round-trips", () => {
        const yaml = serializeFeatureYaml({ title: "Autenticação", description: "" });
        assert.deepEqual(parseFeatureYaml(yaml), { title: "Autenticação", description: "" });
    });

    test("rejects unknown keys, non-mappings and invalid YAML", () => {
        assert.throws(() => parseSpecYaml("title: x\nextra: 1\n"), YamlParseError);
        assert.throws(() => parseFeatureYaml("- a\n- b\n"), /must be a mapping/);
        assert.throws(() => parseSpecYaml("title: [unclosed\n"), /Invalid YAML/);
        assert.throws(() => parseSpecYaml("steps: nope\n"), /must be a list/);
        assert.equal(parseYamlTitle("title: [unclosed"), null);
        assert.deepEqual(parseSpecYaml(""), {
            title: null,
            description: "",
            humanSpec: { preconditions: [], steps: [], expectedResult: "", postconditions: [] },
        });
    });

    const context: ProjectContext = {
        ...EMPTY_PROJECT_CONTEXT,
        summary: "Loja",
        areas: [{ name: "Carrinho", routes: ["/cart"], description: "Itens" }],
        terminology: [{ term: "SKU", meaning: "Código do produto" }],
        roles: [{ name: "Admin", capabilities: ["gerenciar"] }],
        businessRules: ["Frete grátis acima de 100"],
        sources: [{ url: "https://example.com", note: "home" }],
    };

    test("context.yml round-trips", () => {
        assert.deepEqual(parseContextYaml(serializeContextYaml(context)), context);
        assert.throws(() => parseContextYaml("areas:\n  - name: x\n    bogus: 1\n"), /Unknown key "bogus"/);
    });

    test("sameProjectContext ignores key order but not content", () => {
        const reordered = {
            sources: [{ note: "home", url: "https://example.com" }],
            businessRules: ["Frete grátis acima de 100"],
            roles: [{ capabilities: ["gerenciar"], name: "Admin" }],
            terminology: [{ meaning: "Código do produto", term: "SKU" }],
            areas: [{ description: "Itens", routes: ["/cart"], name: "Carrinho" }],
            unknowns: [],
            executionNotes: [],
            uiPatterns: [],
            summary: "Loja",
        } as ProjectContext;
        assert.ok(sameProjectContext(context, reordered));
        assert.ok(sameProjectContext(context, { ...context, summary: "  Loja  " }), "normalized like a read-back");
        assert.ok(!sameProjectContext(context, { ...context, summary: "Outra" }));
        assert.ok(!sameProjectContext(context, { ...context, businessRules: [] }));
    });
});

describe("safe-fs", () => {
    test("normal read and write inside the root work", async () => {
        const root = tempDir();
        await fs.mkdir(path.join(root, "specs", "a"), { recursive: true });
        const file = path.join(root, "specs", "a", "spec.yml");
        await writeRepoFile(root, file, "title: x\n");
        assert.equal(await readRepoFile(root, file), "title: x\n");
        assert.equal(await readOptionalRepoFile(root, path.join(root, "missing.yml")), null);
        await assertRepoPathSafe(root, path.join(root, "specs", "new", "deep"));
    });

    test("rejects paths that escape the root", async () => {
        const root = tempDir();
        await assert.rejects(readRepoFile(root, path.join(root, "..", "etc-passwd")), UnsafeRepoPathError);
        await assert.rejects(writeRepoFile(root, "/tmp/outside.txt", "x"), UnsafeRepoPathError);
        await assert.rejects(assertRepoPathSafe(root, root), UnsafeRepoPathError);
    });

    test("rejects a symlinked target", async () => {
        const root = tempDir();
        const outside = tempDir();
        await fs.writeFile(path.join(outside, "secret.txt"), "top secret");
        await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "spec.yml"));
        await assert.rejects(readRepoFile(root, path.join(root, "spec.yml")), UnsafeRepoPathError);
        await assert.rejects(readOptionalRepoFile(root, path.join(root, "spec.yml")), UnsafeRepoPathError);
        await assert.rejects(writeRepoFile(root, path.join(root, "spec.yml"), "overwrite"), UnsafeRepoPathError);
        assert.equal(await fs.readFile(path.join(outside, "secret.txt"), "utf8"), "top secret");
    });

    test("rejects a symlinked parent directory", async () => {
        const root = tempDir();
        const outside = tempDir();
        await fs.mkdir(path.join(root, "specs"));
        await fs.symlink(outside, path.join(root, "specs", "linked"));
        const target = path.join(root, "specs", "linked", "spec.yml");
        await assert.rejects(writeRepoFile(root, target, "x"), UnsafeRepoPathError);
        await assert.rejects(assertRepoPathSafe(root, path.join(root, "specs", "linked", "sub", "x")), UnsafeRepoPathError);
        assert.deepEqual(await fs.readdir(outside), []);
    });
});
