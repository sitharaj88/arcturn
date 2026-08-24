# Recipe — ArchUnit (JVM: Java, Kotlin, Scala)

Architecture rules as ordinary unit tests, evaluated over compiled bytecode.

This file is data. Nothing in this folder is executable and nothing runs at install
time; the configuration and commands below are printed for you to put in a repository
and run in a session.

Do not copy a dependency version out of this file. Read the current release from the
repository's own dependency catalogue or from Maven Central, and print the resolved
version in your transcript.

---

## 1. Install

Gradle (Kotlin DSL):

```kotlin
dependencies {
    testImplementation("com.tngtech.archunit:archunit-junit5:<version>")
}
```

Maven:

```xml
<dependency>
  <groupId>com.tngtech.archunit</groupId>
  <artifactId>archunit-junit5</artifactId>
  <version><!-- read it, do not copy it --></version>
  <scope>test</scope>
</dependency>
```

Confirm what actually resolved before you trust anything:

```bash
./gradlew :app:dependencies --configuration testRuntimeClasspath | grep archunit
```

## 2. The rule

```java
package com.example.arch;

import com.tngtech.archunit.core.importer.ImportOption;
import com.tngtech.archunit.junit.AnalyzeClasses;
import com.tngtech.archunit.junit.ArchTest;
import com.tngtech.archunit.lang.ArchRule;

import static com.tngtech.archunit.library.Architectures.layeredArchitecture;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;

@AnalyzeClasses(packages = "com.example", importOptions = ImportOption.DoNotIncludeTests.class)
class ArchitectureTest {

    @ArchTest
    static final ArchRule domain_does_not_depend_on_infrastructure =
        noClasses()
            .that().resideInAPackage("..domain..")
            .should().dependOnClassesThat().resideInAPackage("..infra..")
            .because("ADR-0007: the domain is persistence-agnostic");

    @ArchTest
    static final ArchRule layers_are_respected =
        layeredArchitecture().consideringOnlyDependenciesInLayers()
            .layer("Web").definedBy("..web..")
            .layer("Service").definedBy("..service..")
            .layer("Domain").definedBy("..domain..")
            .whereLayer("Web").mayNotBeAccessedByAnyLayer()
            .whereLayer("Service").mayOnlyBeAccessedByLayers("Web")
            .whereLayer("Domain").mayOnlyBeAccessedByLayers("Service", "Web");
}
```

`consideringOnlyDependenciesInLayers()` matters: the default considers every dependency,
including third-party ones, which turns a layer rule into a much wider claim than the
one you meant. Whichever you pick, write it down.

## 3. Make an empty rule fail

This is the setting that decides whether the check can rot silently. A rule whose
`that()` clause matches no classes — after a package rename, a module split, a typo —
**passes by default**. Turn that off:

```properties
# src/test/resources/archunit.properties
archRule.failOnEmptyShould=true
```

Per rule, the same control is `.allowEmptyShould(false)`. Set the property globally and
say in your output that you set it; an ArchUnit suite without it is the textbook
`UNPROVEN CHECK`, and it is the reason the empty-set precondition exists in the skill's
section 1.

## 4. Run, and what the exit code means

```bash
./gradlew test --tests '*ArchitectureTest*'
echo "exit: $?"
```

```bash
mvn -Dtest=ArchitectureTest test
echo "exit: $?"
```

A rule violation is a failing JUnit test, so the exit code is the build's: non-zero, with
ArchUnit's own message naming the rule and listing every violating class and the line it
was found on.

**ArchUnit reads bytecode, not source.** Two consequences to state in your transcript:

- The classes must have been compiled. A test task that skipped compilation, or a module
  that did not build, produces a green ArchUnit run over nothing. Check that the build
  actually compiled the module you are asserting about.
- The bytecode is what the compiler produced. Kotlin `inline` functions, generated
  builders, records, lambdas and synthetic accessors appear in it and can produce
  dependencies that do not exist in the source you are reading.

## 5. The verify loop

```bash
git status --porcelain                                  # must be empty
./gradlew test --tests '*ArchitectureTest*' ; echo "exit: $?"      # expect 0

# plant: one import, in a class inside the rule's "from" set
#   e.g. add `import com.example.infra.JdbcOrderRepository;` and a field referencing it
#   to com/example/domain/Order.java  — a bare unused import is erased by the compiler
#   and will NOT appear in bytecode, so the reference has to be real.
git diff
./gradlew test --tests '*ArchitectureTest*' ; echo "exit: $?"      # expect non-zero,
#   and expect "domain_does_not_depend_on_infrastructure" in the failure message

git checkout -- src/main/java/com/example/domain/Order.java
git status --porcelain
./gradlew test --tests '*ArchitectureTest*' ; echo "exit: $?"      # expect 0
```

The unused-import trap is specific to this tool and it will waste an afternoon: an import
statement that nothing uses does not survive into the class file, so the planted
violation must be a used reference — a field, a parameter, a call.

## 6. The allowlist mechanism

`FreezingArchRule` records current violations to a store and fails only on new ones:

```java
@ArchTest
static final ArchRule domain_does_not_depend_on_infrastructure =
    FreezingArchRule.freeze(
        noClasses().that().resideInAPackage("..domain..")
            .should().dependOnClassesThat().resideInAPackage("..infra..")
    );
```

The first run writes `archunit_store/` and passes. That is exactly `HEAD-VIOLATES`
recorded as a decision, and it is a good mechanism used deliberately and a silent
failure used to get to green. If you propose it: print how many violations the freeze
would record, name the file it writes, and say that the frozen list is a debt register
somebody has to own and shrink.

## 7. Blind spots — plant against these, do not assume

| Shape | Likely outcome | How to test it |
|---|---|---|
| `Class.forName("com.example.infra.Jdbc")` | **not caught** — a string is not a dependency in bytecode | plant it; record the green run in `Scope of this check` |
| Spring `@Autowired` on an interface bound elsewhere | the interface is a dependency, the implementation is not | plant against the implementation package |
| `ServiceLoader` / `META-INF/services` | not caught | plant a registration and look |
| a package that no longer exists | **passes silently** unless `failOnEmptyShould=true` | rename the package in the rule to something imaginary and confirm the rule now fails |
| generated sources | included if compiled into the analysed classes | check `@AnalyzeClasses` package scope |
| a multi-module build | `packages = "com.example"` only sees classes on the analysed classpath | run the rule in each module that must obey it, or import from the whole classpath deliberately |

The imaginary-package test in row four is the cheapest high-value check in this file: it
proves the rule is looking at something. Run it once when you write the rule.
