import { XMLParser } from "fast-xml-parser";
import { readFileSync, writeFileSync } from "fs";

interface TestCase {
  name: string;
  classname?: string;
  failure?: unknown;
  skipped?: unknown;
}

function formatDuration(sec: number) {
  return sec > 1 ? `${sec.toFixed(2)} s` : `${(sec * 1000).toFixed(0)} ms`;
}

function githubFileLink(file: string, sha: string) {
  return `https://github.com/${process.env.GITHUB_REPOSITORY}/blob/${sha}/${file}`;
}

const xml = readFileSync("junit.xml", "utf8");
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
const data = parser.parse(xml);

const suites = data.testsuites;
const suiteList = Array.isArray(suites.testsuite) ? suites.testsuite : [suites.testsuite];
const totalTests = Number(suites.tests);
const totalFailures = Number(suites.failures);
const totalSkipped = Number(suites.skipped);
const totalTime = Number(suites.time);

const sha = process.env.GITHUB_SHA || "";
const startTime = new Date().toLocaleString();

let md = `# Test Dashboard

`;

md += "| :clock10: Start time | :hourglass: Duration |\n";
md += "| --- | ---: |\n";
md += `|${startTime}|${formatDuration(totalTime)}|\n\n`;

md += "| | :white_check_mark: Passed | :x: Failed | :construction: Todo | :white_circle: Total |\n";
md += "| --- | ---: | ---: | ---:| ---: |\n";
md += `|Test Suites|${suiteList.length}|${totalFailures}|-|${suiteList.length}|\n`;
md += `|Tests|${totalTests - totalFailures - totalSkipped}|${totalFailures}|${totalSkipped}|${totalTests}|\n`;

for (const suite of suiteList) {
  const file = suite.file || suite.name;
  const fileLink = githubFileLink(file, sha);
  const cases = suite.testsuite?.testcase || suite.testcase || [];
  const testcases = Array.isArray(cases) ? cases : [cases];
  const passed = testcases.filter((tc) => !tc.failure && !tc.skipped).length;
  const failed = testcases.filter((tc) => !!tc.failure).length;
  const skipped = testcases.filter((tc) => !!tc.skipped).length;
  const suiteTime = Number(suite.time || 0);

  md += `\n## ${file} [[link](${fileLink})]\n\n${passed} passed, ${failed} failed, ${skipped} todo, done in ${formatDuration(suiteTime)}\n`;

  const classGroups: Record<string, TestCase[]> = {};
  for (const tc of testcases) {
    const testCase = tc as TestCase;
    const group = testCase.classname || "Tests";
    if (!classGroups[group]) classGroups[group] = [];
    classGroups[group].push(testCase);
  }

  for (const group of Object.keys(classGroups)) {
    md += `\n- :white_check_mark: ${group}`;
    for (const tc of classGroups[group]) {
      let status = ":white_check_mark:";
      if (tc.failure) status = ":x:";
      else if (tc.skipped) status = ":construction:";
      md += `\n  - ${status} ${tc.name}`;
    }
  }
  md += "\n";
}

writeFileSync("test-dashboard.md", md);
