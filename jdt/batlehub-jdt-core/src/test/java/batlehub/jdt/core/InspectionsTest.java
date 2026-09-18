package batlehub.jdt.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** Positive / negative / fix per inspection, over the same code path the delegate runs. */
class InspectionsTest {
  static List<String> codes(String src) {
    return Engine.list(src).stream().map(r -> (String) r.get("code")).toList();
  }

  static String fixed(String src, String rule) {
    return Engine.applyFixAll(src, rule);
  }

  @Test
  void elevenRulesAreDiscovered() {
    assertEquals(11, Engine.inspections().size());
  }

  @Test
  void unusedPrivateField() {
    String src = "class A { private int unused; private int used; int f() { return used; } }";
    assertEquals(List.of("unused/privateField"), codes(src));
    assertEquals("class A { private int used; int f() { return used; } }", fixed(src, "privateField"));
    assertEquals(List.of(), codes("class A { private int x; int f() { return x; } }"));
  }

  @Test
  void unusedPrivateMethod() {
    String src = "class A { private void dead() {} private void live() {} void f() { live(); } }";
    assertEquals(List.of("unused/privateMethod"), codes(src));
    assertEquals("class A { private void live() {} void f() { live(); } }", fixed(src, "privateMethod"));
    assertEquals(List.of(), codes("class A { private void r() {} void f() { Runnable x = this::r; } }"));
  }

  @Test
  void redundantThis() {
    String src = "class A { int x; int f() { return this.x; } void set(int x) { this.x = x; } }";
    assertEquals(List.of("style/redundantThis"), codes(src));
    assertEquals("class A { int x; int f() { return x; } void set(int x) { this.x = x; } }", fixed(src, "redundantThis"));
  }

  @Test
  void sizeIsZero() {
    String src = "import java.util.*; class A { List<String> l; boolean e() { return l.size() == 0; } boolean n() { return l.size() > 0; } boolean m() { return 0 != l.size(); } }";
    assertEquals(List.of("collections/sizeIsZero", "collections/sizeIsZero", "collections/sizeIsZero"), codes(src));
    assertEquals("import java.util.*; class A { List<String> l; boolean e() { return l.isEmpty(); } boolean n() { return !l.isEmpty(); } boolean m() { return !l.isEmpty(); } }", fixed(src, "sizeIsZero"));
    assertEquals(List.of(), codes("class A { int size() { return 1; } boolean f() { return size() == 1; } }"));
  }

  @Test
  void stringConcatInLoop() {
    String src = "class A { String f(String[] a) { String out = \"\"; for (String s : a) { out = out + s + \"\\n\"; } out += \"end\"; return out; } }";
    assertEquals(List.of("performance/stringConcatInLoop"), codes(src));
    assertEquals(src, fixed(src, "stringConcatInLoop"), "no fix: a refactoring, not a quick fix");
  }

  @Test
  void missingOverride() {
    String src = "class A { public String toString() { return \"\"; } @Override public int hashCode() { return 1; } public boolean equals(Object o) { return false; } }";
    assertEquals(List.of("correctness/missingOverride", "correctness/missingOverride"), codes(src));
    assertEquals("class A { @Override\npublic String toString() { return \"\"; } @Override public int hashCode() { return 1; } @Override\npublic boolean equals(Object o) { return false; } }", fixed(src, "missingOverride"));
  }

  @Test
  void objectsEqualsLiteral() {
    String src = "import java.util.Objects; class A { boolean f(String s) { return Objects.equals(\"x\", s) || Objects.equals(s, s); } }";
    assertEquals(List.of("correctness/objectsEqualsLiteral"), codes(src));
    assertEquals("import java.util.Objects; class A { boolean f(String s) { return \"x\".equals(s) || Objects.equals(s, s); } }", fixed(src, "objectsEqualsLiteral"));
  }

  @Test
  void boxingConstructor() {
    String src = "class A { Object f() { return new Integer(3); } Object g() { return Integer.valueOf(3); } }";
    assertEquals(List.of("performance/boxingConstructor"), codes(src));
    assertEquals("class A { Object f() { return Integer.valueOf(3); } Object g() { return Integer.valueOf(3); } }", fixed(src, "boxingConstructor"));
  }

  @Test
  void emptyCatch() {
    assertEquals(List.of("correctness/emptyCatch"), codes("class A { void f() { try { g(); } catch (Exception e) { } } void g() {} }"));
    assertEquals(List.of(), codes("class A { void f() { try { g(); } catch (Exception ignored) { } } void g() {} }"));
  }

  @Test
  void booleanLiteralComparison() {
    String src = "class A { boolean f(boolean b) { return b == true; } boolean g(boolean b) { return b != true; } boolean h(int i) { return (i > 1) == false; } }";
    assertEquals(3, codes(src).size());
    assertEquals("class A { boolean f(boolean b) { return b; } boolean g(boolean b) { return !b; } boolean h(int i) { return !(i > 1); } }", fixed(src, "booleanLiteralComparison"));
  }

  @Test
  void ifReturnBoolean() {
    String src = "class A { boolean f(int i) { if (i > 1) { return true; } else { return false; } } boolean g(int i) { if (i > 1) return false; else return true; } }";
    assertEquals(List.of("style/ifReturnBoolean", "style/ifReturnBoolean"), codes(src));
    assertEquals("class A { boolean f(int i) { return i > 1; } boolean g(int i) { return !(i > 1); } }", fixed(src, "ifReturnBoolean"));
  }

  @Test
  void rowsCarryLspRangesAndFixTitles() {
    var rows = Engine.list("class A {\n  private int unused;\n}\n");
    assertEquals(1, rows.size());
    @SuppressWarnings("unchecked")
    var range = (Map<String, Map<String, Integer>>) rows.get(0).get("range");
    assertEquals(1, range.get("start").get("line"));
    assertEquals(14, range.get("start").get("character"));
    assertEquals("Remove 'unused'", rows.get(0).get("fixTitle"));
    assertEquals("warning", rows.get(0).get("severity"));
  }

  @Test
  void fixAllIsOneEditListAndOtherRulesAreLeftAlone() {
    String src = "class A {\n  private int unused;\n  boolean f(java.util.List<String> l) { return l.size() == 0; }\n}\n";
    var edits = Engine.fixAll(src, null);
    assertTrue(edits.size() >= 2, "edits: " + edits);
    assertEquals(List.of(), Engine.fixAll("class A {}", null));
    assertEquals("class A {\n  private int unused;\n  boolean f(java.util.List<String> l) { return l.isEmpty(); }\n}\n", fixed(src, "sizeIsZero"));
  }
}
