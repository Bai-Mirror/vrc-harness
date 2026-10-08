// Compile and run the extracted comparison logic from FaceStage.cs, so the preserve check is tested by
// execution rather than by pattern matching its source text.
//
// The failure this covers is that a measured component serialises differently depending on whether it is
// carried as float or double (0.37877363 against 0.37877362999999997), and a text comparison called that a
// change on an untouched source. Asserting the source contains a tolerance would not catch a tolerance
// that is too small to absorb the difference, so run the method on that exact pair.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { removeTemp } from './fixtures/platform.ts';

const tool = fileURLToPath(new URL('../builtin/tools/harness/unity/Editor/FaceStage.cs', import.meta.url));
const csc = 'C:\\Program Files\\Unity\\Hub\\Editor\\2022.3.22f1\\Editor\\Data\\DotNetSdkRoslyn\\csc.dll';
const dotnet = spawnSync('dotnet', ['--version']).status === 0;
const compilable = dotnet && existsSync(csc);

/** Cut a method out of the editor source by its signature and its closing brace at method indentation. */
function extractMethod(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `missing ${signature}`);
  const end = source.indexOf('\n        }\n', start);
  assert.ok(end >= 0, `unterminated ${signature}`);
  return source.slice(start, end + '\n        }\n'.length);
}

test('an unchanged source is not reported as changed just because a number is typed differently', { skip: !compilable }, t => {
  const source = readFileSync(tool, 'utf8').replace(/\r\n/g, '\n');
  const logic = extractMethod(source, 'static string FirstJsonDifference(object left, object right, string at)');
  const constants = /const double NumberTolerance = [^;]+;/.exec(source)?.[0];
  const floor = /const double NumberFloor = [^;]+;/.exec(source)?.[0];
  const isNumber = /static bool IsNumber\(object value\) =>[^;]+;/.exec(source)?.[0];
  const shorten = /static string Shorten\(string text\) =>[^;]+;/.exec(source)?.[0];
  for (const [name, part] of Object.entries({ constants, floor, isNumber, shorten })) assert.ok(part, `missing ${name}`);

  const root = mkdtempSync(join(tmpdir(), 'avh-face-compare-'));
  t.after(() => removeTemp(root));
  writeFileSync(join(root, 'Program.cs'), `using System;
using System.Collections.Generic;
using System.Linq;

static class Avh
{
    public static string Json(object value) => value switch
    {
        null => "null",
        float f => f.ToString("R", System.Globalization.CultureInfo.InvariantCulture),
        double d => d.ToString("R", System.Globalization.CultureInfo.InvariantCulture),
        _ => Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture),
    };
}

class Program
{
    ${constants}
    ${floor}
    ${isNumber}
    ${shorten}
${logic}
    static int Main()
    {
        var failures = 0;
        // Equal by value, different by type and therefore by text: the real failing pair.
        failures += Expect(null, 0.37877363f, 0.37877363d, "float against double of one measurement");
        failures += Expect(null, 0.37877363f, 0.37877362999999997d, "the exact texts seen in the field");
        // The decisive case: the two sides print differently and only a numeric comparison can say they
        // are the same value. Without it this reports a change, which is the defect being fixed.
        var high = (double)0.37877363f;
        var low = high - high * 1e-8;
        failures += Expect(null, (float)low, high, "one measurement printed two ways");
        failures += Expect(null, 0f, 0d, "zero against zero");
        failures += Expect(null, 1e-12f, 2e-12d, "near zero, where a relative term alone vanishes");
        failures += Expect(null, 1f, 1, "float against int");
        // Real changes must still be reported.
        failures += Expect("changed", 0.37877363f, 0.38d, "a real difference");
        failures += Expect("changed", 1f, 2f, "one against two");
        failures += Expect("changed", 1e-3f, 2e-3d, "a real difference near zero");
        // Text and structure still compare exactly.
        failures += Expect("changed", "a", "b", "different strings");
        failures += Expect(null, "a", "a", "same strings");
        Console.WriteLine(failures == 0 ? "compare ok" : $"compare failed {failures}");
        return failures == 0 ? 0 : 1;
    }

    static int Expect(string expected, object left, object right, string what)
    {
        var actual = FirstJsonDifference(left, right, "at");
        if (expected == null) { if (actual != null) { Console.WriteLine($"FAIL {what}: reported {actual}"); return 1; } return 0; }
        if (actual == null) { Console.WriteLine($"FAIL {what}: reported equal"); return 1; }
        return 0;
    }
}
`);
  writeFileSync(join(root, 'compare.csproj'), `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>disable</Nullable>
    <AssemblyName>compare</AssemblyName>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
  </PropertyGroup>
  <ItemGroup><Compile Include="Program.cs" /></ItemGroup>
</Project>
`);
  const output = execFileSync('dotnet', ['run', '--project', root, '-v', 'quiet'], { encoding: 'utf8', env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1' } });
  assert.match(output, /compare ok/, output);
});
