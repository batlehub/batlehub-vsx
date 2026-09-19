package batlehub.jdt.core;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** Golden file per option set (RFC 0001 §10 layer 1b). */
class AccessorsTest {
  static String golden(String name) throws IOException {
    return Files.readString(Path.of("src/test/resources/golden", name), StandardCharsets.UTF_8);
  }

  /** `-Dgolden.update=true` rewrites the goldens from the actual output; the diff is then reviewed. */
  static void check(String name, String actual) throws IOException {
    if (Boolean.getBoolean("golden.update")) Files.writeString(Path.of("src/test/resources/golden", name), actual, StandardCharsets.UTF_8);
    assertEquals(golden(name), actual, name);
  }

  static String generate(String src, Map<String, Object> options) {
    var cu = Engine.parse(src);
    return Engine.apply(src, Accessors.rewrite(cu, src.indexOf("class Person"), Accessors.Options.of(options), Engine.indentUnit(src)));
  }

  @Test
  void bothWithDefaults() throws IOException {
    check("Person.both-default.java", generate(golden("Person.java"), Map.of()));
  }

  @Test
  void gettersOnly() throws IOException {
    check("Person.getters-only.java", generate(golden("Person.java"), Map.of("kind", 1)));
  }

  @Test
  void fluentSettersCustomPrefixesSkipFinal() throws IOException {
    check(
        "Person.fluent-skipfinal.java",
        generate(golden("Person.java"), Map.of("getterPrefix", "fetch", "booleanPrefix", "has", "fluentSetters", true, "finalFields", "skipSetters")));
  }

  @Test
  void existingAccessorsAreKept() throws IOException {
    String once = generate(golden("Person.java"), Map.of());
    assertEquals(once, generate(once, Map.of()));
  }

  @Test
  void optionsFromJsonShapes() {
    var o = Accessors.Options.of(Map.of("kind", 2.0, "finalFields", "skipSetters", "fluentSetters", Boolean.TRUE));
    assertEquals(2, o.kind());
    assertEquals(true, o.skipFinalSetters());
    assertEquals(true, o.fluentSetters());
    assertEquals("get", o.getterPrefix());
  }
}
