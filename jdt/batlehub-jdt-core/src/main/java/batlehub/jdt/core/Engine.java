package batlehub.jdt.core;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.ServiceLoader;
import org.eclipse.jdt.core.JavaCore;
import org.eclipse.jdt.core.dom.AST;
import org.eclipse.jdt.core.dom.ASTNode;
import org.eclipse.jdt.core.dom.ASTParser;
import org.eclipse.jdt.core.dom.CompilationUnit;
import org.eclipse.jdt.core.dom.rewrite.ASTRewrite;
import org.eclipse.jface.text.BadLocationException;
import org.eclipse.jface.text.Document;
import org.eclipse.jface.text.IDocument;
import org.eclipse.text.edits.DeleteEdit;
import org.eclipse.text.edits.InsertEdit;
import org.eclipse.text.edits.MultiTextEdit;
import org.eclipse.text.edits.ReplaceEdit;
import org.eclipse.text.edits.TextEdit;

/**
 * The headless core: source in, findings and LSP edits out. Nothing here
 * touches the workspace, so the JUnit layer (1b) exercises exactly what the
 * delegate runs.
 */
public final class Engine {
  private Engine() {}

  public static List<Inspection> inspections() {
    List<Inspection> out = new ArrayList<>();
    ServiceLoader.load(Inspection.class, Engine.class.getClassLoader()).forEach(out::add);
    return out;
  }

  public static CompilationUnit parse(String source) {
    ASTParser parser = ASTParser.newParser(AST.getJLSLatest());
    parser.setKind(ASTParser.K_COMPILATION_UNIT);
    parser.setSource(source.toCharArray());
    parser.setCompilerOptions(options());
    parser.setResolveBindings(false);
    return (CompilationUnit) parser.createAST(null);
  }

  /**
   * Compiler and formatter options without the OSGi platform: JavaCore.getOptions()
   * needs the workspace, and the tests have none. ponytail: tabs of 4, project
   * formatter preferences ignored; read them through the IJavaProject when
   * someone asks for their own indentation.
   */
  public static Map<String, String> options() {
    return options("");
  }

  /** Indentation read off the file itself: the first indented line decides tab or N spaces. */
  public static Map<String, String> options(String source) {
    Map<String, String> o = new java.util.HashMap<>();
    JavaCore.setComplianceOptions(JavaCore.VERSION_21, o);
    java.util.regex.Matcher m = java.util.regex.Pattern.compile("(?m)^( +|\\t)\\S").matcher(source);
    String indent = m.find() ? m.group(1) : "\t";
    boolean tab = indent.startsWith("\t");
    o.put(org.eclipse.jdt.core.formatter.DefaultCodeFormatterConstants.FORMATTER_TAB_CHAR, tab ? JavaCore.TAB : JavaCore.SPACE);
    o.put(org.eclipse.jdt.core.formatter.DefaultCodeFormatterConstants.FORMATTER_TAB_SIZE, tab ? "4" : String.valueOf(indent.length()));
    o.put(org.eclipse.jdt.core.formatter.DefaultCodeFormatterConstants.FORMATTER_INDENTATION_SIZE, tab ? "4" : String.valueOf(indent.length()));
    return o;
  }

  public static List<Finding> findings(CompilationUnit cu, String ruleId) {
    List<Finding> out = new ArrayList<>();
    for (Inspection i : inspections()) {
      if (ruleId == null || ruleId.equals(i.id())) i.visit(cu, out);
    }
    out.sort((a, b) -> Integer.compare(a.node().getStartPosition(), b.node().getStartPosition()));
    return out;
  }

  /** The list command's rows: plain maps, so Gson sends them as-is. */
  public static List<Map<String, Object>> list(String source) {
    CompilationUnit cu = parse(source);
    List<Map<String, Object>> rows = new ArrayList<>();
    for (Finding f : findings(cu, null)) {
      Map<String, Object> row = new LinkedHashMap<>();
      row.put("ruleId", f.rule().id());
      row.put("area", f.rule().area());
      row.put("code", f.rule().area() + "/" + f.rule().id());
      row.put("message", f.message());
      row.put("severity", f.rule().severity());
      row.put("range", range(cu, f.node().getStartPosition(), f.node().getLength()));
      if (f.fixTitle() != null) row.put("fixTitle", f.fixTitle());
      rows.add(row);
    }
    return rows;
  }

  /** Every fix of every finding (of one rule when given), as one edit list. */
  public static List<Map<String, Object>> fixAll(String source, String ruleId) {
    CompilationUnit cu = parse(source);
    ASTRewrite rewrite = ASTRewrite.create(cu.getAST());
    boolean any = false;
    for (Finding f : findings(cu, ruleId)) {
      if (f.fix() == null) continue;
      f.fix().accept(rewrite);
      any = true;
    }
    return any ? edits(source, rewrite) : List.of();
  }

  /** `text` with the edits of `rewrite` applied — what the tests compare to a golden. */
  public static String apply(String source, ASTRewrite rewrite) {
    Document doc = new Document(source);
    try {
      rewrite.rewriteAST(doc, options(source)).apply(doc);
    } catch (BadLocationException e) {
      throw new IllegalStateException(e);
    }
    return doc.get();
  }

  public static String applyFixAll(String source, String ruleId) {
    CompilationUnit cu = parse(source);
    ASTRewrite rewrite = ASTRewrite.create(cu.getAST());
    for (Finding f : findings(cu, ruleId)) if (f.fix() != null) f.fix().accept(rewrite);
    return apply(source, rewrite);
  }

  /** An ASTRewrite as LSP `TextEdit`s over `source` (line/character, 0-based). */
  public static List<Map<String, Object>> edits(String source, ASTRewrite rewrite) {
    Document doc = new Document(source);
    TextEdit edit = rewrite.rewriteAST(doc, options(source));
    List<Map<String, Object>> out = new ArrayList<>();
    flatten(edit, doc, out);
    return out;
  }

  private static void flatten(TextEdit edit, IDocument doc, List<Map<String, Object>> out) {
    if (edit instanceof MultiTextEdit) {
      for (TextEdit child : edit.getChildren()) flatten(child, doc, out);
      return;
    }
    String text = edit instanceof ReplaceEdit r ? r.getText() : edit instanceof InsertEdit i ? i.getText() : edit instanceof DeleteEdit ? "" : null;
    if (text == null) return;
    Map<String, Object> e = new LinkedHashMap<>();
    e.put("range", range(doc, edit.getOffset(), edit.getLength()));
    e.put("newText", text);
    out.add(e);
  }

  static Map<String, Object> range(CompilationUnit cu, int offset, int length) {
    return range(cu.getLineNumber(offset) - 1, cu.getColumnNumber(offset), cu.getLineNumber(offset + length) - 1, cu.getColumnNumber(offset + length));
  }

  static Map<String, Object> range(IDocument doc, int offset, int length) {
    try {
      int l1 = doc.getLineOfOffset(offset);
      int l2 = doc.getLineOfOffset(offset + length);
      return range(l1, offset - doc.getLineOffset(l1), l2, offset + length - doc.getLineOffset(l2));
    } catch (BadLocationException e) {
      throw new IllegalStateException(e);
    }
  }

  private static Map<String, Object> range(int l1, int c1, int l2, int c2) {
    Map<String, Object> r = new LinkedHashMap<>();
    r.put("start", Map.of("line", l1, "character", c1));
    r.put("end", Map.of("line", l2, "character", c2));
    return r;
  }

  /** The indentation unit `options(source)` decided: a tab, or N spaces. */
  public static String indentUnit(String source) {
    Map<String, String> o = options(source);
    return JavaCore.TAB.equals(o.get(org.eclipse.jdt.core.formatter.DefaultCodeFormatterConstants.FORMATTER_TAB_CHAR)) ? "\t" : " ".repeat(Integer.parseInt(o.get(org.eclipse.jdt.core.formatter.DefaultCodeFormatterConstants.FORMATTER_INDENTATION_SIZE)));
  }

  /** LSP `Position` → offset in `source`. */
  public static int offsetOf(String source, int line, int character) {
    try {
      return new Document(source).getLineOffset(line) + character;
    } catch (BadLocationException e) {
      return 0;
    }
  }

  /** The innermost node of `type` covering `offset`, or null. */
  @SuppressWarnings("unchecked")
  public static <T extends ASTNode> T enclosing(ASTNode node, int offset, Class<T> type) {
    ASTNode best = null;
    for (ASTNode n = node; n != null; ) {
      if (type.isInstance(n) && n.getStartPosition() <= offset && offset <= n.getStartPosition() + n.getLength()) best = n;
      ASTNode next = null;
      for (Object child : n.structuralPropertiesForType()) {
        Object v = n.getStructuralProperty((org.eclipse.jdt.core.dom.StructuralPropertyDescriptor) child);
        if (v instanceof ASTNode c && c.getStartPosition() <= offset && offset <= c.getStartPosition() + c.getLength()) next = c;
        else if (v instanceof List<?> list) for (Object o : list) if (o instanceof ASTNode c && c.getStartPosition() <= offset && offset <= c.getStartPosition() + c.getLength()) next = c;
      }
      n = next;
    }
    return (T) best;
  }
}
