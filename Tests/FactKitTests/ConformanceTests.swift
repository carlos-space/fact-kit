import FactKit
import Foundation
import Testing

// Runs the shared samples in conformance/ against the Swift reader. The expected results were written by hand.
// A new sample directory needs no change here.

private let caseNames = Conformance.subdirectories("cases").map(SampleCase.init)
private let resolveNames = Conformance.subdirectories("resolve").map(SampleCase.init)

@Suite("conformance")
struct ConformanceTests {
  @Test("conformance/ is found, and there are samples")
  func samplesExist() throws {
    let directory = try #require(Conformance.directory, "set FACT_KIT_CONFORMANCE or run inside the repository")
    #expect(caseNames.count >= 80)
    #expect(resolveNames.count >= 15)
    #expect(SemverSamples.compares.count > 50)
    #expect(SemverSamples.lines.count > 5)
    for sample in caseNames {
      for file in ["index.json", "query.json", "expected.json"] {
        let path = directory.appendingPathComponent("cases/\(sample.name)/\(file)").path
        #expect(FileManager.default.fileExists(atPath: path), "\(sample.name)/\(file)")
      }
    }
  }

  @Test("cases: selectFacts", arguments: caseNames)
  func selectCase(_ sample: SampleCase) throws {
    let directory = try #require(Conformance.directory).appendingPathComponent("cases/\(sample.name)")
    let query = try Conformance.readJSON(directory.appendingPathComponent("query.json"))
    let index = try Data(contentsOf: directory.appendingPathComponent("index.json"))
    let got = try Conformance.outcome {
      try selectFacts(
        index,
        version: Conformance.option(query, "version"),
        include: Conformance.include(query),
        platform: Conformance.option(query, "platform"),
        os: Conformance.option(query, "os")
      )
    }
    let expected = try Conformance.readJSON(directory.appendingPathComponent("expected.json"))
    #expect(got == expected, "\(sample.name): got \(got), expected \(expected)")
  }

  @Test("resolve: readFacts", arguments: resolveNames)
  func resolveCase(_ sample: SampleCase) throws {
    let directory = try #require(Conformance.directory).appendingPathComponent("resolve/\(sample.name)")
    let query = try Conformance.readJSON(directory.appendingPathComponent("query.json"))
    let spec = try #require(Conformance.option(query, "spec"))
    let root = directory.appendingPathComponent("root", isDirectory: true)
    let got = try Conformance.outcome {
      try readFacts(
        spec,
        root: root,
        version: Conformance.option(query, "version"),
        include: Conformance.include(query),
        platform: Conformance.option(query, "platform"),
        os: Conformance.option(query, "os")
      ).facts
    }
    let expected = try Conformance.readJSON(directory.appendingPathComponent("expected.json"))
    #expect(got == expected, "\(sample.name): got \(got), expected \(expected)")
  }

  @Test("semver: compare", arguments: SemverSamples.compares)
  func compare(_ sample: SemverCompare) throws {
    #expect(try compareVersions(sample.a, sample.b) == sample.expected)
  }

  @Test("semver: release line", arguments: SemverSamples.lines)
  func line(_ sample: SemverLine) throws {
    #expect(try releaseLine(sample.version) == sample.line)
  }
}
