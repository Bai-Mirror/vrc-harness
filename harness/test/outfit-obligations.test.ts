// Run the obligation decision from OutfitStage.cs, so "promised but not done" is caught by execution.
//
// Two independent reviews of the earlier coverage check converged on one defect: it asked whether a product
// was mentioned anywhere, not whether what the plan promised actually happened. A plan could name a
// package, promise in its notes to attach it, attach nothing, and pass every check. This covers the repair,
// where the postcondition is read from the artifact and the record only says what to look for.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { removeTemp } from './fixtures/platform.ts';

const tool = fileURLToPath(new URL('../builtin/tools/harness/unity/Editor/OutfitStage.cs', import.meta.url));
const compilable = process.platform === 'win32';

/**
 * The obligation rules, which are pure apart from the artifact lookup the caller supplies.
 *
 * The Unity overload is deliberately excluded: it is the only piece that needs a GameObject, so the rule
 * it delegates to can be compiled and run without the editor.
 */
function extractObligationLogic(source: string): string {
  const start = source.indexOf('public static List<Dictionary<string, object>> Obligations(');
  assert.ok(start >= 0, 'Obligations missing');
  const unityOverload = source.indexOf('public static List<Dictionary<string, object>> UnmetObligations(', start);
  assert.ok(unityOverload > start, 'Unity overload missing');
  const end = source.indexOf('\n        static void Walk(', unityOverload);
  assert.ok(end > unityOverload, 'obligation helpers have no end');
  // The Unity overload sits between the declarations and the pure decision it delegates to.
  const overloadEnd = source.indexOf('\n        }\n', unityOverload) + '\n        }\n'.length;
  return source.slice(start, unityOverload) + source.slice(overloadEnd, end);
}

test('a promise the artifact does not hold is reported, and a kept one is not', { skip: !compilable }, t => {
  const source = readFileSync(tool, 'utf8').replace(/\r\n/g, '\n');
  const logic = extractObligationLogic(source);
  // Normalize sits above the extracted block, so take it as well.
  const normalize = /static string Normalize\(string path\) =>[^;]+;/.exec(source)?.[0];
  assert.ok(normalize, 'Normalize missing');

  const root = mkdtempSync(join(tmpdir(), 'avh-obligations-'));
  t.after(() => removeTemp(root));

  const program = `global using static AvhRead;
using System;
using System.Collections.Generic;
using System.Linq;

static class AvhRead
{
    public static string Str(this Dictionary<string, object> map, string key) =>
        map != null && map.TryGetValue(key, out var value) && value != null ? value.ToString() : "";
    public static List<object> List(this Dictionary<string, object> map, string key) =>
        map != null && map.TryGetValue(key, out var value) && value is List<object> list ? list : new List<object>();
}

class Rules
{
    public static Dictionary<string, object> D(params object[] pairs)
    {
        var map = new Dictionary<string, object>();
        for (var i = 0; i + 1 < pairs.Length; i += 2) map[(string)pairs[i]] = pairs[i + 1];
        return map;
    }
    public static List<object> L(params object[] items) => items.ToList();

${normalize}
${logic}
    static int Main()
    {
        var failures = 0;
        // The record claims the stocking outfit and names its object, but the artifact does not hold it:
        // this is the shape that a record-only check calls success.
        var record = D("outfits", L(D("item", "C:/m/Stocking.zip", "object", "_Outfit/Outfit_stocking"),
                                     D("item", "C:/m/Snowflake.zip", "object", "_Outfit/Outfit_snowflake")));
        var plan = D("obligations", L(
            D("input", "C:/m/Stocking.zip", "role", "outfit", "action", "use", "target", "_Outfit/Outfit_stocking", "due_stage", "outfit"),
            D("input", "C:/m/Snowflake.zip", "role", "outfit", "action", "use", "target", "_Outfit/Outfit_snowflake", "due_stage", "outfit"),
            D("input", "C:/m/Materials.zip", "role", "texture", "action", "use", "target", "C:/m/Snowflake.zip", "due_stage", "outfit"),
            D("input", "C:/m/Sweety.zip", "role", "other", "action", "exclude", "reason", "overlap"),
            D("input", "C:/m/Later.zip", "role", "texture", "action", "defer", "due_stage", "recolor", "reason", "used when coloring"),
            D("input", "C:/m/Next.zip", "role", "outfit", "action", "use", "target", "_Outfit/Outfit_next", "due_stage", "menu")));

        Func<string, bool> onlySnowflake = path => path == "_Outfit/Outfit_snowflake";
        var unmet = UnmetObligations(record, plan, onlySnowflake);
        var names = unmet.Select(o => o.Str("input")).OrderBy(x => x, StringComparer.Ordinal).ToList();
        failures += Check(names.SequenceEqual(new[] { "C:/m/Stocking.zip" }),
            "expected only the stocking promise to be unmet, got " + string.Join(", ", names));

        // Nothing is due here when every promise is kept, deferred elsewhere, or excluded.
        var allPresent = UnmetObligations(record, plan, _ => true);
        failures += Check(allPresent.Count == 0, $"expected no unmet obligation, got {allPresent.Count}");

        // Excluding and deferring are dispositions, not failures: an artifact with nothing in it satisfies
        // neither a defer to another stage nor an authorized exclusion.
        var planDispositionsOnly = D("obligations", L(
            D("input", "C:/m/Sweety.zip", "role", "other", "action", "exclude", "reason", "overlap"),
            D("input", "C:/m/Later.zip", "role", "texture", "action", "defer", "due_stage", "recolor", "reason", "later")));
        failures += Check(UnmetObligations(record, planDispositionsOnly, _ => false).Count == 0,
            "an exclusion and a deferral must not be reported as unmet work");

        // A product the record never names cannot be satisfied by another product's presence.
        var recordOther = D("outfits", L(D("item", "C:/m/Snowflake.zip", "object", "_Outfit/Outfit_snowflake")));
        var stockOnly = D("obligations", L(
            D("input", "C:/m/Stocking.zip", "role", "outfit", "action", "use", "target", "_Outfit/Outfit_stocking", "due_stage", "outfit")));
        failures += Check(UnmetObligations(recordOther, stockOnly, _ => true).Count == 1,
            "a product absent from the record must stay unmet however much the artifact holds");

        // A material package is proved by the input that carries it, so an absent carrier leaves both
        // promises unmet rather than passing on the package's own word.
        var carrierAbsent = UnmetObligations(record, plan, _ => false);
        var absentNames = carrierAbsent.Select(o => o.Str("input")).OrderBy(x => x, StringComparer.Ordinal).ToList();
        failures += Check(absentNames.SequenceEqual(new[] { "C:/m/Materials.zip", "C:/m/Snowflake.zip", "C:/m/Stocking.zip" }),
            "an absent carrier must leave its package unmet too, got " + string.Join(", ", absentNames));

        // A texture that names no carrier, or names one that is not itself used, has no postcondition this
        // stage can read, so it stays unmet instead of passing on an unfalsifiable promise.
        foreach (var target in new[] { "", "C:/m/Later.zip", "C:/m/Missing.zip" })
        {
            var orphan = D("obligations", L(
                D("input", "C:/m/Materials.zip", "role", "texture", "action", "use", "target", target, "due_stage", "outfit"),
                D("input", "C:/m/Later.zip", "role", "texture", "action", "defer", "due_stage", "recolor", "reason", "later")));
            failures += Check(UnmetObligations(record, orphan, _ => true).Count == 1,
                $"a package whose carrier is '{target}' must stay unmet");
        }

        var install = D("obligations", L(
            D("input", "body", "role", "body", "action", "use", "target", "Assets/Base.prefab", "due_stage", "outfit"),
            D("input", "toolkit", "role", "other", "action", "use", "target", "body", "due_stage", "outfit")));
        var bodyOnly = D("body_prefab", "Assets/Base.prefab", "outfits", L());
        failures += Check(UnmetObligations(bodyOnly, install, _ => true).Count == 1,
            "a present body cannot discharge an installation input");
        bodyOnly["outfits"] = L(D("item", "toolkit", "object", "Attachments/IndependentInstall"));
        failures += Check(UnmetObligations(bodyOnly, install, path => path == "Attachments/IndependentInstall").Count == 0,
            "an installation input proves its own artifact even without grouped schema");
        failures += Check(UnmetObligations(bodyOnly, install, _ => false).Count == 1,
            "an installation record without the actual instance stays unmet");
        install.List("obligations").Add(D("input", "surface", "role", "texture", "action", "use", "target", "toolkit", "due_stage", "outfit"));
        failures += Check(UnmetObligations(bodyOnly, install, _ => true).Count == 0,
            "a material dependency may be carried by a proven installation instance");
        failures += Check(UnmetObligations(bodyOnly, install, _ => false).Count == 2,
            "an absent installation also leaves its material dependency unmet");
        // A registered input the record mounts as an outfit is answered by that outfit's own artifact, even
        // when its plan role is "other" and its declared carrier is the body. This is the general form of the
        // false pass D-115 names: the plan names the package, the record mounts it, the artifact does not hold
        // it, and a body reference used to discharge it because the schema was plan/0.2 and the record
        // therefore had no avatar_config to key on.
        var absentMount = D("outfits", L(D("item", "C:/m/Body.zip", "object", "Body"),
                                         D("item", "C:/m/Accessory.zip", "object", "_Outfit/Outfit_accessory")),
                            "body_prefab", "Assets/Body.prefab");
        var carrierPlan = D("obligations", L(
            D("input", "C:/m/Accessory.zip", "role", "other", "action", "use", "target", "C:/m/Body.zip", "due_stage", "outfit"),
            D("input", "C:/m/Body.zip", "role", "body", "action", "use", "target", "Body", "due_stage", "outfit")));
        Func<string, bool> onlyCarrierBody = path => path == "Body";
        foreach (var schema in new[] { "plan/0.2", "plan/0.3" })
        {
        carrierPlan["schema"] = schema;
        if (schema == "plan/0.3") absentMount["avatar_config"] = D(); else absentMount.Remove("avatar_config");
        var carried = UnmetObligations(absentMount, carrierPlan, onlyCarrierBody);
        failures += Check(carried.Count == 1 && carried[0].Str("input") == "C:/m/Accessory.zip",
            "an input the record mounts must not be discharged by its carrier when the artifact lacks it, got " +
            string.Join(", ", carried.Select(o => o.Str("input"))));
        // The same plan with the mount actually present is satisfied, so the rule above reports the missing
        // artifact rather than the shape of the obligation.
        var presentMount = D("outfits", L(D("item", "C:/m/Body.zip", "object", "Body"),
                                         D("item", "C:/m/Accessory.zip", "object", "_Outfit/Outfit_accessory")),
                             "body_prefab", "Assets/Body.prefab");
        failures += Check(UnmetObligations(presentMount, carrierPlan, path => path == "Body" || path == "_Outfit/Outfit_accessory").Count == 0,
            "a mounted input whose artifact is present must be satisfied");
        }

        Console.WriteLine(failures == 0 ? "obligations ok" : $"obligations failed {failures}");
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
  writeFileSync(join(root, 'obligations.csproj'), `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>disable</Nullable>
    <LangVersion>latest</LangVersion>
    <AssemblyName>obligations</AssemblyName>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
  </PropertyGroup>
  <ItemGroup><Compile Include="Program.cs" /></ItemGroup>
</Project>
`);
  const output = execFileSync('dotnet', ['run', '--project', root, '-v', 'quiet'],
    { encoding: 'utf8', env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1' } });
  assert.match(output, /obligations ok/, output);
  const mutant = logic.replace('if (role == "texture")', 'if (role == "texture" || role == "other")');
  assert.notEqual(mutant, logic);
  writeFileSync(join(root, 'Program.cs'), program.replace(logic, mutant));
  const mutation = spawnSync('dotnet', ['run', '--project', root, '-v', 'quiet'], {encoding: 'utf8', env: {...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1'}});
  assert.equal(mutation.status, 1, mutation.stdout + mutation.stderr);
  assert.match(mutation.stdout, /present body cannot discharge an installation input/);
  const carrierMutant = mutant.replace('if (mounted.Count > 0) return mounted.All(e => objectExists(e.Str("object")));', '');
  assert.notEqual(carrierMutant, mutant);
  writeFileSync(join(root, 'Program.cs'), program.replace(logic, carrierMutant));
  const missingMountMutation = spawnSync('dotnet', ['run', '--project', root, '-v', 'quiet'], {encoding: 'utf8', env: {...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1'}});
  assert.equal(missingMountMutation.status, 1, missingMountMutation.stdout + missingMountMutation.stderr);
  assert.match(missingMountMutation.stdout, /an input the record mounts must not be discharged by its carrier/);
});
