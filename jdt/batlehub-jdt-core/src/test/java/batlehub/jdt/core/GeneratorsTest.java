package batlehub.jdt.core;

import static batlehub.jdt.core.AccessorsTest.check;
import static batlehub.jdt.core.AccessorsTest.golden;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** RFC 0015 phase 1: the builder and the withers, one golden file per option set (layer 1b). */
class GeneratorsTest {
  static Builders.Result builder(String src, Map<String, Object> o) {
    return Builders.build(Engine.parse(src), src.indexOf("class "), Builders.Options.of(o), Engine.indentUnit(src));
  }

  static Builders.Result withers(String src, Map<String, Object> o) {
    int at = src.contains("record ") ? src.indexOf("record ") : src.indexOf("class ");
    return Withers.build(Engine.parse(src), at, Withers.Options.of(o), Engine.indentUnit(src));
  }

  static String applied(String src, Builders.Result r) {
    assertNull(r.refused(), r.refused());
    return Engine.apply(src, r.rewrite());
  }

  @Test
  void innerBuilderWithWithMethods() throws IOException {
    // Use case 1: final id included, the initialized final and the static left out.
    check("Customer.builder-inner.java", applied(golden("Customer.java"), builder(golden("Customer.java"), Map.of())));
  }

  @Test
  void setPrefixAndChosenFields() throws IOException {
    check("Customer.builder-set-some.java", applied(golden("Customer.java"), builder(golden("Customer.java"), Map.of("methodPrefix", "set", "fields", List.of("name", "id")))));
  }

  @Test
  void builderInItsOwnFile() throws IOException {
    Builders.Result r = builder(golden("Customer.java"), Map.of("placement", "file", "methodPrefix", ""));
    assertEquals("CustomerBuilder.java", r.newFile());
    check("Customer.builder-file.java", applied(golden("Customer.java"), r));
    check("CustomerBuilder.java", r.newText());
  }

  @Test
  void rerunAddsOnlyTheNewField() throws IOException {
    // Use case 2: a field added after the first run; every existing member kept.
    String once = applied(golden("Customer.java"), builder(golden("Customer.java"), Map.of()));
    assertEquals(once, applied(once, builder(once, Map.of())));
    String grown = once.replace("    private static int count;", "    private static int count;\n    private String email;");
    check("Customer.builder-rerun.java", applied(grown, builder(grown, Map.of())));
  }

  @Test
  void lombokAddsTheAnnotationAndNothingElse() throws IOException {
    String src = golden("Customer.java");
    String once = applied(src, builder(src, Map.of("lombok", true)));
    check("Customer.builder-lombok.java", once);
    assertEquals(once, applied(once, builder(once, Map.of("lombok", true))));
  }

  @Test
  void recordWithersCopy() throws IOException {
    check("Point.withers-copy.java", applied(golden("Point.java"), withers(golden("Point.java"), Map.of())));
  }

  @Test
  void recordMutateIsRefused() throws IOException {
    // Use case 4: a record has no assignable field.
    Builders.Result r = withers(golden("Point.java"), Map.of("style", "mutate"));
    assertNotNull(r.refused());
    assertTrue(r.refused().contains("record"), r.refused());
    assertEquals(golden("Point.java"), Engine.apply(golden("Point.java"), r.rewrite()));
  }

  @Test
  void classWithersCopyAndMutate() throws IOException {
    check("Money.withers-copy.java", applied(golden("Money.java"), withers(golden("Money.java"), Map.of())));
    // mutate skips the final field
    check("Money.withers-mutate.java", applied(golden("Money.java"), withers(golden("Money.java"), Map.of("style", "mutate", "methodPrefix", "set"))));
  }

  @Test
  void classCopyWithoutAnAllFieldsConstructorIsRefused() throws IOException {
    Builders.Result r = withers(golden("Customer.java"), Map.of());
    assertNotNull(r.refused());
    assertTrue(r.refused().contains("Generate ▸ Constructors"), r.refused());
  }

  @Test
  void anInterfaceGetsNoBuilderAndAPrefixCannotInjectSource() {
    String src = "interface Shape {}\n";
    assertNotNull(Builders.build(Engine.parse(src), 0, Builders.Options.of(Map.of()), "    ").refused());
    assertThrows(IllegalArgumentException.class, () -> Builders.Options.of(Map.of("methodPrefix", "x(){} void y")));
  }
}
