package batlehub.jdt.core;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.eclipse.jdt.core.dom.ASTNode;
import org.eclipse.jdt.core.dom.AbstractTypeDeclaration;
import org.eclipse.jdt.core.dom.CompilationUnit;
import org.eclipse.jdt.core.dom.FieldDeclaration;
import org.eclipse.jdt.core.dom.MethodDeclaration;
import org.eclipse.jdt.core.dom.Modifier;
import org.eclipse.jdt.core.dom.PrimitiveType;
import org.eclipse.jdt.core.dom.TypeDeclaration;
import org.eclipse.jdt.core.dom.VariableDeclarationFragment;
import org.eclipse.jdt.core.dom.rewrite.ASTRewrite;
import org.eclipse.jdt.core.dom.rewrite.ListRewrite;

/**
 * Getters and setters with the options of RFC 0001 §4.1, through ASTRewrite
 * and string placeholders — the machinery JDT's own GenerateGetterSetterOperation
 * uses, minus the dialog. Options in, edits out.
 */
public final class Accessors {
  private Accessors() {}

  public record Options(String getterPrefix, String booleanPrefix, boolean fluentSetters, boolean skipFinalSetters, int kind) {
    public static Options of(Map<String, Object> m) {
      String finals = String.valueOf(m.getOrDefault("finalFields", "keepSetters"));
      Object k = m.getOrDefault("kind", 0);
      return new Options(
          String.valueOf(m.getOrDefault("getterPrefix", "get")),
          String.valueOf(m.getOrDefault("booleanPrefix", "is")),
          Boolean.TRUE.equals(m.get("fluentSetters")),
          "skipSetters".equals(finals),
          k instanceof Number n ? n.intValue() : Integer.parseInt(String.valueOf(k)));
    }
  }

  /** The rewrite for the type at `offset` (the first type when none encloses it). */
  public static ASTRewrite rewrite(CompilationUnit cu, int offset, Options o, String indent) {
    AbstractTypeDeclaration type = Engine.enclosing(cu, offset, AbstractTypeDeclaration.class);
    if (type == null && !cu.types().isEmpty()) type = (AbstractTypeDeclaration) cu.types().get(0);
    ASTRewrite rewrite = ASTRewrite.create(cu.getAST());
    if (!(type instanceof TypeDeclaration td)) return rewrite;
    Set<String> methods = new HashSet<>();
    for (MethodDeclaration m : td.getMethods()) methods.add(m.getName().getIdentifier() + "/" + m.parameters().size());
    ListRewrite body = rewrite.getListRewrite(td, TypeDeclaration.BODY_DECLARATIONS_PROPERTY);
    List<String> stubs = new ArrayList<>();
    for (FieldDeclaration f : td.getFields()) {
      boolean isStatic = Modifier.isStatic(f.getModifiers());
      boolean isFinal = Modifier.isFinal(f.getModifiers());
      boolean isBoolean = f.getType().isPrimitiveType() && ((PrimitiveType) f.getType()).getPrimitiveTypeCode() == PrimitiveType.BOOLEAN;
      String typeName = f.getType().toString();
      for (Object frag : f.fragments()) {
        String name = ((VariableDeclarationFragment) frag).getName().getIdentifier();
        String cap = Character.toUpperCase(name.charAt(0)) + name.substring(1);
        String getter = (isBoolean ? o.booleanPrefix() : o.getterPrefix()) + cap;
        String setter = "set" + cap;
        String mods = "public " + (isStatic ? "static " : "");
        if (o.kind() != 2 && !methods.contains(getter + "/0")) {
          stubs.add(mods + typeName + " " + getter + "() {\n" + indent + "return " + name + ";\n}");
        }
        if (o.kind() != 1 && !methods.contains(setter + "/1") && !(isFinal && o.skipFinalSetters())) {
          String ret = o.fluentSetters() && !isStatic ? td.getName().getIdentifier() : "void";
          String assign = (isStatic ? td.getName().getIdentifier() + "." : "this.") + name + " = " + name + ";";
          stubs.add(mods + ret + " " + setter + "(" + typeName + " " + name + ") {\n" + indent + assign + (o.fluentSetters() && !isStatic ? "\n" + indent + "return this;" : "") + "\n}");
        }
      }
    }
    for (String s : stubs) body.insertLast(rewrite.createStringPlaceholder(s, ASTNode.METHOD_DECLARATION), null);
    return rewrite;
  }
}
