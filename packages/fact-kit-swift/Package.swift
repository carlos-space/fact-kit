// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "FactKit",
  platforms: [.macOS(.v13), .iOS(.v16), .tvOS(.v16), .watchOS(.v9)],
  products: [
    .library(name: "FactKit", targets: ["FactKit"])
  ],
  dependencies: [
    .package(url: "https://github.com/SwiftPackageIndex/SemanticVersion", from: "0.5.3")
  ],
  targets: [
    .target(
      name: "FactKit",
      dependencies: [.product(name: "SemanticVersion", package: "SemanticVersion")]
    ),
    .testTarget(name: "FactKitTests", dependencies: ["FactKit"]),
  ],
  swiftLanguageModes: [.v6]
)
