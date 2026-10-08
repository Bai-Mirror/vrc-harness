// Run the coverage logic from OutfitStage.cs against real inputs, so the check is tested by execution.
//
// The defect this covers is that every install check asks only about what the plan names, so a plan that
// names less passes all of them: four products were registered, the plan mounted one, and the assembly
// reported success. Coverage is computed from the intake inventory against the plan's dispositions, and
// the assertions below fail if that computation stops noticing an undisposed product.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { removeTemp } from './fixtures/platform.ts';

const tool = fileURLToPath(new URL('../builtin/tools/harness/unity/Editor/OutfitStage.cs', import.meta.url));
const compilable = process.platform === 'win32';

/** The coverage function through the path normaliser it uses, plus the declaration reader it consults. */
function extractCoverage(source: string): string {
  const start = source.indexOf('public static List<(string item, string role, string reason)> UncoveredInputs(');
  assert.ok(start >= 0, 'coverage function missing');
  // The obligation helpers follow and one of them takes a GameObject, so the cut has to land before them.
  const boundary = source.indexOf('/// <summary>One declaration per registered input', start);
  assert.ok(boundary > start, 'obligation section missing');
  const end = source.lastIndexOf('\n', boundary);
  assert.ok(end > start, 'coverage function has no end');
  // Coverage now counts a declared disposition as a decision about the input, so it reads the plan's
  // obligations. Only the declaration reader comes along: the rules that judge whether a promise was
  // kept are tested next door, and the Unity overload cannot be compiled here.
  const next = source.indexOf('/// <summary>', boundary + '/// <summary>'.length);
  assert.ok(next > boundary, 'the declaration reader has no end');
  return source.slice(start, end) + '\n' + source.slice(boundary, next);
}

test('a registered product the plan never disposes is reported, and a disposed one is not', { skip: !compilable }, t => {
  const source = readFileSync(tool, 'utf8');
  const coverage = extractCoverage(source);

  const root = mkdtempSync(join(tmpdir(), 'avh-coverage-'));
  t.after(() => removeTemp(root));
  const project = join(root, 'project');
  mkdirSync(join(project, '_harness', 'intake'), { recursive: true });
  writeFileSync(join(project, '_harness', 'intake', 'inventory.json'), JSON.stringify({
    schema: 'inventory/0.1',
    items: [
      { item: 'C:/m/Milfy_v1.5.0.zip', role: 'body', found: true },
      { item: 'C:/m/Snowflake.zip', role: 'outfit', found: true },
      { item: 'C:/m/LUNALICE.zip', role: 'other', found: true },
      { item: 'C:/m/Stocking.zip', role: 'outfit', found: true },
      { item: 'C:/m/GoldenHour.zip', role: 'other', found: true },
      { item: 'C:/m/GoldenHourMaterials.zip', role: 'texture', found: true },
      { item: 'C:/m/Sweety.zip', role: 'other', found: true },
      // Two vendors ship the same file name; they are different registrations and must stay independent.
      { item: 'C:/AuthorA/Hair.unitypackage', role: 'other', found: true },
      { item: 'C:/AuthorB/Hair.unitypackage', role: 'other', found: true },
    ],
  }));

  const program = `// The reading helpers the editor code expects from Avh, reduced to what the coverage function uses.
// The global using must precede the plain ones, and every type declaration after them, so the extracted
// method can call the extension methods without its own text being edited.
global using static AvhRead;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;

static class AvhRead
{
    public static string Str(this Dictionary<string, object> map, string key) =>
        map != null && map.TryGetValue(key, out var value) && value != null ? value.ToString() : "";
    public static List<object> List(this Dictionary<string, object> map, string key) =>
        map != null && map.TryGetValue(key, out var value) && value is List<object> list ? list : new List<object>();
}

static class Avh
{
    public static string ProjectDir = "";
    public static string Abs(string relative) => Path.Combine(ProjectDir, relative.Replace('/', Path.DirectorySeparatorChar));
    public static Dictionary<string, object> ReadJsonFile(string path)
    {
        if (!File.Exists(path)) return null;
        using var document = JsonDocument.Parse(File.ReadAllText(path));
        return Convert(document.RootElement) as Dictionary<string, object>;
    }
    static object Convert(JsonElement element) => element.ValueKind switch
    {
        JsonValueKind.Object => element.EnumerateObject().ToDictionary(p => p.Name, p => Convert(p.Value)),
        JsonValueKind.Array => element.EnumerateArray().Select(Convert).ToList(),
        JsonValueKind.String => element.GetString(),
        JsonValueKind.Number => element.TryGetInt64(out var l) ? l : element.GetDouble(),
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        _ => null,
    };
}


class Walk
{
    public static Dictionary<string, object> D(params object[] pairs)
    {
        var map = new Dictionary<string, object>();
        for (var i = 0; i + 1 < pairs.Length; i += 2) map[(string)pairs[i]] = pairs[i + 1];
        return map;
    }
    public static List<object> L(params object[] items) => items.ToList();

${coverage}
    static int Main()
    {
        Avh.ProjectDir = ${JSON.stringify(project)};
        var failures = 0;

        // The real shape: the plan mounts one product and declares one unused, so three registered
        // products reached no disposition and must be reported.
        var planPartial = D("outfits", L(D("id", "snowflake", "item", "C:/m/Snowflake.zip")),
                            "unused", L(D("item", "C:/m/Sweety.zip", "reason", "overlap")));
        var recordPartial = D("body", "C:/m/Milfy_v1.5.0.zip", "body_prefab", "Assets/Body.prefab",
                              "outfits", L(D("id", "snowflake", "item", "C:/m/Snowflake.zip", "object", "_Outfit/snowflake")));
        var partial = UncoveredInputs(recordPartial, planPartial);
        // The plan mounts Snowflake, declares Sweety unused, and names the body, so the knife, the
        // stockings, the hair and its material pack reached no disposition. That is the real shape.
        var partialNames = partial.Select(x => Path.GetFileName(x.item)).OrderBy(x => x, StringComparer.Ordinal).ToList();
        var expectedNames = new[] { "GoldenHour.zip", "GoldenHourMaterials.zip", "Hair.unitypackage", "Hair.unitypackage", "LUNALICE.zip", "Stocking.zip" };
        failures += Check(partialNames.SequenceEqual(expectedNames),
            $"expected {string.Join(", ", expectedNames)}, got {string.Join(", ", partialNames)}");
        failures += Check(partial.All(x => !string.IsNullOrEmpty(x.reason)), "every report needs a reason");

        // Every product disposed: mounted, declared unused, or carried as a package member.
        var planFull = D("outfits", L(D("id", "snowflake", "item", "C:/m/Snowflake.zip"),
                                     D("id", "lunalice", "item", "C:/m/LUNALICE.zip"),
                                     D("id", "stocking", "item", "C:/m/Stocking.zip")),
                         "unused", L(D("item", "C:/m/Sweety.zip", "reason", "overlap"),
                                     D("item", "C:/m/GoldenHour.zip", "reason", "overlap"),
                                     D("item", "C:/AuthorA/Hair.unitypackage", "reason", "overlap"),
                                     D("item", "C:/AuthorB/Hair.unitypackage", "reason", "overlap")),
                         "obligations", L(D("input", "C:/m/GoldenHourMaterials.zip", "role", "texture",
                                            "action", "use", "target", "C:/m/Stocking.zip", "due_stage", "outfit")));
        var recordFull = D("body", "C:/m/Milfy_v1.5.0.zip", "body_prefab", "Assets/Body.prefab",
                           "outfits", L(D("id", "snowflake", "item", "C:/m/Snowflake.zip", "object", "_Outfit/snowflake"),
                                        D("id", "lunalice", "item", "C:/m/LUNALICE.zip", "object", "_Outfit/lunalice"),
                                        D("id", "stocking", "item", "C:/m/Stocking.zip", "object", "_Outfit/stocking")));
        var full = UncoveredInputs(recordFull, planFull);
        failures += Check(full.Count == 0, $"expected full coverage, got {full.Count}: " +
            string.Join(", ", full.Select(x => Path.GetFileName(x.item))));

        // A package merely listed as a dependency, with nothing referencing it, is not thereby used.
        var planDependencyOnly = D("outfits", L(D("id", "snowflake", "item", "C:/m/Snowflake.zip"),
                                                D("id", "lunalice", "item", "C:/m/LUNALICE.zip"),
                                                D("id", "stocking", "item", "C:/m/Stocking.zip")),
                                   "unused", L(D("item", "C:/m/Sweety.zip", "reason", "overlap")),
                                   "packages", L(D("item", "C:/m/GoldenHour.zip"), D("item", "C:/m/GoldenHourMaterials.zip")));
        var dependencyOnly = UncoveredInputs(recordFull, planDependencyOnly);
        failures += Check(dependencyOnly.Any(x => x.item.EndsWith("GoldenHour.zip")),
            "listing a package as a dependency must not discharge it");

        // Identity, not file name: two registrations sharing a basename stay independent.
        var planOneOfTwo = D("outfits", L(D("id", "hair", "item", "C:/AuthorA/Hair.unitypackage")));
        var recordOneOfTwo = D("body_prefab", "Assets/Body.prefab",
                               "outfits", L(D("id", "hair", "item", "C:/AuthorA/Hair.unitypackage")));
        var sameName = UncoveredInputs(recordOneOfTwo, planOneOfTwo);
        failures += Check(sameName.Any(x => x.item.EndsWith("AuthorB/Hair.unitypackage")),
            "a same-named package from another vendor must not be treated as disposed");

        // The body resolves to a prefab elsewhere, so it is judged by the resolved prefab, not by path.
        var bodyResolved = D("body", "C:/m/Milfy_v1.5.0.zip", "body_prefab", "Assets/PLUSONE/Milfy/Prefab/Milfy.prefab", "outfits", L());
        failures += Check(!UncoveredInputs(bodyResolved, D("outfits", L())).Any(x => x.role == "body"),
            "a resolved body prefab disposes the registered body package");

        // Paths written with either separator are the same product.
        var planWindows = D("outfits", L(D("id", "snowflake", "item", "C:\\\\m\\\\Snowflake.zip")));
        var recordWindows = D("body_prefab", "Assets/Body.prefab",
                              "outfits", L(D("id", "snowflake", "item", "C:\\\\m\\\\Snowflake.zip")));
        var mixed = UncoveredInputs(recordWindows, planWindows);
        failures += Check(!mixed.Any(x => x.item.EndsWith("Snowflake.zip")), "separator style must not decide coverage");

        Console.WriteLine(failures == 0 ? "coverage ok" : $"coverage failed {failures}");
        return failures == 0 ? 0 : 1;
    }

    static int Check(bool ok, string what)
    {
        if (!ok) { Console.WriteLine($"FAIL {what}"); return 1; }
        return 0;
    }
}
`;
  writeFileSync(join(root, 'Program.cs'), program);
  writeFileSync(join(root, 'coverage.csproj'), `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>disable</Nullable>
    <AssemblyName>coverage</AssemblyName>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
    <LangVersion>latest</LangVersion>
    <NoWarn>CS0219;CS8321</NoWarn>
  </PropertyGroup>
  <ItemGroup><Compile Include="Program.cs" /></ItemGroup>
</Project>
`);
  const output = execFileSync('dotnet', ['run', '--project', root, '-v', 'quiet'],
    { encoding: 'utf8', env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1' } });
  assert.match(output, /coverage ok/, output);
});
