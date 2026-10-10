package batlehub.jdt.core;

import static batlehub.jdt.core.AccessorsTest.check;
import static batlehub.jdt.core.AccessorsTest.golden;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** RFC 0015 phase 2: surround-with, one golden per construct, and the range rules (layer 1b, no bindings). */
class SurroundTest {
  static Builders.Result wrap(String src, int start, int end, String construct) {
    return Surround.wrap(Engine.parse(src), src, start, end, Surround.Options.of(Map.of("construct", construct)), Engine.indentUnit(src));
  }

  static String applied(String src, Builders.Result r) {
    assertNull(r.refused(), r.refused());
    return Engine.apply(src, r.rewrite());
  }

  @Test
  void threeStatementsWidenedAndALocalHoisted() throws IOException {
    // Use case 5: from mid-way through the first statement to before the third's semicolon; b is used after.
    String src = golden("Steps.java");
    int start = src.indexOf("a = 1;"), end = src.indexOf("a + 1;") + 4;
    check("Steps.surround-tryCatch.java", applied(src, wrap(src, start, end, "tryCatch")));
  }

  @Test
  void everyConstructOnTheStatementUnderTheCursor() throws IOException {
    String src = golden("Steps.java");
    int at = src.indexOf("System.out.println(a)") + 3;
    for (String c : new String[] {"if", "ifElse", "while", "for", "tryFinally", "synchronized", "runnable"})
      check("Steps.surround-" + c + ".java", applied(src, wrap(src, at, at, c)));
  }

  @Test
  void tryWithResourcesTakesTheFirstDeclaration() throws IOException {
    String src = golden("Steps.java");
    int start = src.indexOf("FileInputStream in"), end = src.indexOf("in.read();") + 10;
    check("Steps.surround-tryWithResources.java", applied(src, wrap(src, start, end, "tryWithResources")));
  }

  @Test
  void aLoneDeclarationUsedAfterIsHoisted() throws IOException {
    // The commonest case: select `int b = a + 1;`, surround with try — b is used below.
    String src = golden("Steps.java");
    int at = src.indexOf("int b = a + 1;") + 2;
    check("Steps.surround-hoisted-alone.java", applied(src, wrap(src, at, at, "tryCatch")));
  }

  @Test
  void refusalsLeaveTheFileAlone() throws IOException {
    String src = golden("Steps.java");
    // Use case 6: a var local used after the selection.
    int v = src.indexOf("var v");
    Builders.Result r = wrap(src, v, v + 10, "tryCatch");
    assertNotNull(r.refused());
    assertTrue(r.refused().contains("\"v\" is used after the selection"), r.refused());
    // Not inside a block: a field initializer.
    int f = src.indexOf("1 + 2");
    assertNotNull(wrap(src, f, f + 5, "if").refused());
    // try-with-resources needs a resource first.
    int p = src.indexOf("System.out.println(a)");
    assertNotNull(wrap(src, p, p, "tryWithResources").refused());
    assertThrows(IllegalArgumentException.class, () -> Surround.Options.of(Map.of("construct", "goto")));
  }
}
