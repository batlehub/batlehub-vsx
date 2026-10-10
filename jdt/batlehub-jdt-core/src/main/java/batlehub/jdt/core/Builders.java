package batlehub.jdt.core;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.eclipse.jdt.core.dom.AST;
import org.eclipse.jdt.core.dom.ASTNode;
import org.eclipse.jdt.core.dom.BodyDeclaration;
import org.eclipse.jdt.core.dom.AbstractTypeDeclaration;
import org.eclipse.jdt.core.dom.CompilationUnit;
import org.eclipse.jdt.core.dom.FieldDeclaration;
import org.eclipse.jdt.core.dom.ImportDeclaration;
import org.eclipse.jdt.core.dom.MethodDeclaration;
import org.eclipse.jdt.core.dom.Modifier;
import org.eclipse.jdt.core.dom.SingleVariableDeclaration;
import org.eclipse.jdt.core.dom.TypeDeclaration;
import org.eclipse.jdt.core.dom.VariableDeclarationFragment;
import org.eclipse.jdt.core.dom.rewrite.ASTRewrite;
import org.eclipse.jdt.core.dom.rewrite.ListRewrite;

/**
 * Generate ▸ Builder (RFC 0015 §4.2): a `builder()` factory, a constructor
 * taking the builder, and a builder class with one prefixed method per field
 * and `build()` — inner (decision 8) or in its own file. Re-running adds only
 * what is missing. Options in, edits out; the bundle asks nothing and writes
 * no file (§5.1): the own-file text is returned for the caller to create.
 */
public final class Builders {
  private Builders() {}

  public record Options(List<String> fields, String methodPrefix, String placement, boolean lombok) {
    public static Options of(Map<String, Object> m) {
      String prefix = String.valueOf(m.getOrDefault("methodPrefix", "with"));
      // §7: a prefix reaches the source, so it is a Java identifier part or nothing.
      if (!prefix.matches("[A-Za-z_$][A-Za-z0-9_$]*|")) throw new IllegalArgumentException("batlehub: methodPrefix is not an identifier: " + prefix);
      return new Options(names(m.get("fields")), prefix, "file".equals(m.get("placement")) ? "file" : "inner", Boolean.TRUE.equals(m.get("lombok")));
    }
  }

  /** The edit for the type's own file, a refusal, or the new file's name and text for `placement: "file"`. */
  public record Result(ASTRewrite rewrite, String refused, String newFile, String newText) {
    static Result refuse(CompilationUnit cu, String why) {
      return new Result(ASTRewrite.create(cu.getAST()), why, null, null);
    }
  }

  record Field(String type, String name) {}

  static List<String> names(Object v) {
    return v instanceof List<?> l ? l.stream().map(String::valueOf).toList() : null;
  }

  static String cap(String s) {
    return Character.toUpperCase(s.charAt(0)) + s.substring(1);
  }

  static String method(String prefix, String name) {
    return prefix.isEmpty() ? name : prefix + cap(name);
  }

  /** The type at `offset`, the first one when none encloses it. */
  static AbstractTypeDeclaration typeAt(CompilationUnit cu, int offset) {
    AbstractTypeDeclaration t = Engine.enclosing(cu, offset, AbstractTypeDeclaration.class);
    return t != null || cu.types().isEmpty() ? t : (AbstractTypeDeclaration) cu.types().get(0);
  }

  /** Instance fields the builder can set: a `final` field with an initializer is already set and is left out. */
  static List<Field> fields(TypeDeclaration td, List<String> wanted) {
    List<Field> out = new ArrayList<>();
    for (FieldDeclaration f : td.getFields()) {
      if (Modifier.isStatic(f.getModifiers())) continue;
      for (Object o : f.fragments()) {
        VariableDeclarationFragment v = (VariableDeclarationFragment) o;
        if (Modifier.isFinal(f.getModifiers()) && v.getInitializer() != null) continue;
        String name = v.getName().getIdentifier();
        if (wanted == null || wanted.contains(name)) out.add(new Field(f.getType().toString() + "[]".repeat(v.getExtraDimensions()), name));
      }
    }
    return out;
  }

  /** Adds `import <name>;` unless the unit already has it. */
  static void importOnce(CompilationUnit cu, ASTRewrite rewrite, String name) {
    for (Object o : cu.imports()) if (((ImportDeclaration) o).getName().getFullyQualifiedName().equals(name)) return;
    rewrite.getListRewrite(cu, CompilationUnit.IMPORTS_PROPERTY).insertLast(rewrite.createStringPlaceholder("import " + name + ";", ASTNode.IMPORT_DECLARATION), null);
  }

  /** `@Builder` / `@With` and its import, the Lombok path (decision 5): nothing else is generated. */
  static Result lombok(CompilationUnit cu, AbstractTypeDeclaration type, String annotation) {
    ASTRewrite rewrite = ASTRewrite.create(cu.getAST());
    for (Object m : type.modifiers())
      if (m instanceof org.eclipse.jdt.core.dom.Annotation a && a.getTypeName().getFullyQualifiedName().endsWith(annotation)) return new Result(rewrite, null, null, null);
    rewrite.getListRewrite(type, type.getModifiersProperty()).insertFirst(rewrite.createStringPlaceholder("@" + annotation, ASTNode.MARKER_ANNOTATION), null);
    importOnce(cu, rewrite, "lombok." + annotation);
    return new Result(rewrite, null, null, null);
  }

  public static Result build(CompilationUnit cu, int offset, Options o, String indent) {
    AbstractTypeDeclaration type = typeAt(cu, offset);
    if (!(type instanceof TypeDeclaration td) || td.isInterface())
      return Result.refuse(cu, "batlehub: the cursor is not in a class" + (type != null ? " (" + type.getName().getIdentifier() + " is not one)" : ""));
    String t = td.getName().getIdentifier();
    TypeDeclaration existing = null;
    for (TypeDeclaration inner : td.getTypes()) if (inner.getName().getIdentifier().equals("Builder")) existing = inner;
    if (o.lombok()) {
      if (existing != null) return Result.refuse(cu, "batlehub: " + t + " already has a hand-written Builder; @Builder would clash with it");
      return lombok(cu, td, "Builder");
    }
    List<Field> fields = fields(td, o.fields());
    if (fields.isEmpty()) return Result.refuse(cu, "batlehub: " + t + " has no field a builder can set");
    boolean ownFile = o.placement().equals("file");
    String b = ownFile ? t + "Builder" : "Builder";
    ASTRewrite rewrite = ASTRewrite.create(cu.getAST());
    ListRewrite body = rewrite.getListRewrite(td, TypeDeclaration.BODY_DECLARATIONS_PROPERTY);
    Set<String> methods = new HashSet<>();
    MethodDeclaration ctor = null;
    for (MethodDeclaration m : td.getMethods()) {
      methods.add(m.getName().getIdentifier() + "/" + m.parameters().size());
      if (m.isConstructor() && m.parameters().size() == 1 && ((SingleVariableDeclaration) m.parameters().get(0)).getType().toString().equals(b)) ctor = m;
    }
    String i2 = indent + indent;

    if (!methods.contains("builder/0"))
      body.insertLast(rewrite.createStringPlaceholder("public static " + b + " builder() {\n" + indent + "return new " + b + "();\n}", ASTNode.METHOD_DECLARATION), null);
    if (ctor == null) {
      StringBuilder c = new StringBuilder((ownFile ? "" : "private ") + t + "(" + b + " b) {");
      for (Field f : fields) c.append("\n").append(indent).append("this.").append(f.name()).append(" = b.").append(f.name()).append(";");
      body.insertLast(rewrite.createStringPlaceholder(c.append("\n}").toString(), ASTNode.METHOD_DECLARATION), null);
    }

    if (ownFile) {
      // §4.3: never over an existing file; the caller checks the disk, this only builds the text.
      String pkg = cu.getPackage() == null ? "" : "package " + cu.getPackage().getName().getFullyQualifiedName() + ";\n\n";
      StringBuilder imports = new StringBuilder();
      for (Object imp : cu.imports()) imports.append(imp.toString().trim()).append("\n");
      StringBuilder s = new StringBuilder(pkg).append(imports.length() > 0 ? imports.append("\n") : "").append("public final class ").append(b).append(" {\n");
      for (Field f : fields) s.append(indent).append(f.type()).append(" ").append(f.name()).append(";\n");
      s.append("\n").append(indent).append(b).append("() {\n").append(indent).append("}\n");
      for (Field f : fields) s.append("\n").append(shift(setter(b, f, o.methodPrefix(), indent), indent)).append("\n");
      s.append("\n").append(indent).append("public ").append(t).append(" build() {\n").append(i2).append("return new ").append(t).append("(this);\n").append(indent).append("}\n}\n");
      return new Result(rewrite, null, b + ".java", s.toString());
    }

    if (existing == null) {
      // A real node whose members are placeholders: the rewrite's formatter
      // spaces and indents them as it does any new member.
      AST ast = cu.getAST();
      TypeDeclaration bt = ast.newTypeDeclaration();
      bt.setName(ast.newSimpleName("Builder"));
      bt.modifiers().addAll(ast.newModifiers(Modifier.PUBLIC | Modifier.STATIC | Modifier.FINAL));
      List<BodyDeclaration> decls = bt.bodyDeclarations();
      for (Field f : fields) decls.add((BodyDeclaration) rewrite.createStringPlaceholder("private " + f.type() + " " + f.name() + ";", ASTNode.FIELD_DECLARATION));
      decls.add((BodyDeclaration) rewrite.createStringPlaceholder("private Builder() {\n}", ASTNode.METHOD_DECLARATION));
      for (Field f : fields) decls.add((BodyDeclaration) rewrite.createStringPlaceholder(setter("Builder", f, o.methodPrefix(), indent), ASTNode.METHOD_DECLARATION));
      decls.add((BodyDeclaration) rewrite.createStringPlaceholder("public " + t + " build() {\n" + indent + "return new " + t + "(this);\n}", ASTNode.METHOD_DECLARATION));
      body.insertLast(bt, null);
      return new Result(rewrite, null, null, null);
    }

    // Re-run (use case 2): only the fields the builder lacks — its field, its
    // method, and the constructor's assignment. Every existing member is kept.
    Set<String> has = new HashSet<>();
    for (FieldDeclaration f : existing.getFields())
      for (Object v : f.fragments()) has.add(((VariableDeclarationFragment) v).getName().getIdentifier());
    ListRewrite inner = rewrite.getListRewrite(existing, TypeDeclaration.BODY_DECLARATIONS_PROPERTY);
    FieldDeclaration[] bf = existing.getFields();
    MethodDeclaration build = null;
    for (MethodDeclaration m : existing.getMethods()) if (m.getName().getIdentifier().equals("build") && m.parameters().isEmpty()) build = m;
    for (Field f : fields) {
      if (has.contains(f.name())) continue;
      ASTNode field = rewrite.createStringPlaceholder("private " + f.type() + " " + f.name() + ";", ASTNode.FIELD_DECLARATION);
      if (bf.length > 0) inner.insertAfter(field, bf[bf.length - 1], null);
      else inner.insertFirst(field, null);
      ASTNode m = rewrite.createStringPlaceholder(setter("Builder", f, o.methodPrefix(), indent), ASTNode.METHOD_DECLARATION);
      if (build != null) inner.insertBefore(m, build, null);
      else inner.insertLast(m, null);
      if (ctor != null)
        rewrite.getListRewrite(ctor.getBody(), org.eclipse.jdt.core.dom.Block.STATEMENTS_PROPERTY)
            .insertLast(rewrite.createStringPlaceholder("this." + f.name() + " = b." + f.name() + ";", ASTNode.EXPRESSION_STATEMENT), null);
    }
    return new Result(rewrite, null, null, null);
  }

  /** One builder method at column 0, its body one unit in: a placeholder re-indents it where it lands. */
  static String setter(String builder, Field f, String prefix, String indent) {
    return "public " + builder + " " + method(prefix, f.name()) + "(" + f.type() + " " + f.name() + ") {\n"
        + indent + "this." + f.name() + " = " + f.name() + ";\n" + indent + "return this;\n}";
  }

  /** `text` one level in, line by line. */
  static String shift(String text, String indent) {
    return indent + text.replace("\n", "\n" + indent);
  }
}
