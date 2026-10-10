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
import org.eclipse.jdt.core.dom.RecordDeclaration;
import org.eclipse.jdt.core.dom.SingleVariableDeclaration;
import org.eclipse.jdt.core.dom.TypeDeclaration;
import org.eclipse.jdt.core.dom.VariableDeclarationFragment;
import org.eclipse.jdt.core.dom.rewrite.ASTRewrite;
import org.eclipse.jdt.core.dom.rewrite.ListRewrite;

/**
 * Generate ▸ With methods (RFC 0015 §4.2): `copy` returns a new instance
 * through the canonical constructor (records, decision 9) or a constructor
 * taking every field (classes); `mutate` assigns and returns `this`, and is
 * refused on records and skips `final` fields. Existing methods are kept.
 */
public final class Withers {
  private Withers() {}

  public record Options(List<String> fields, String methodPrefix, String style, boolean lombok) {
    public static Options of(Map<String, Object> m) {
      Builders.Options b = Builders.Options.of(m);
      return new Options(b.fields(), b.methodPrefix(), "mutate".equals(m.get("style")) ? "mutate" : "copy", b.lombok());
    }
  }

  record Member(String type, String name, boolean assignable) {}

  public static Builders.Result build(CompilationUnit cu, int offset, Options o, String indent) {
    AbstractTypeDeclaration type = Builders.typeAt(cu, offset);
    boolean record = type instanceof RecordDeclaration;
    if (!record && !(type instanceof TypeDeclaration td && !td.isInterface()))
      return Builders.Result.refuse(cu, "batlehub: the cursor is not in a class or a record");
    String t = type.getName().getIdentifier();
    if (o.lombok()) return Builders.lombok(cu, type, "With");
    if (record && o.style().equals("mutate"))
      return Builders.Result.refuse(cu, "batlehub: " + t + " is a record, which has no assignable field: use the copy style");

    // Every member in declaration order: the copy passes all of them.
    List<Member> all = new ArrayList<>();
    if (record) {
      for (Object c : ((RecordDeclaration) type).recordComponents()) {
        SingleVariableDeclaration v = (SingleVariableDeclaration) c;
        all.add(new Member(v.getType().toString(), v.getName().getIdentifier(), false));
      }
    } else {
      for (FieldDeclaration f : ((TypeDeclaration) type).getFields()) {
        if (Modifier.isStatic(f.getModifiers())) continue;
        for (Object fr : f.fragments()) {
          VariableDeclarationFragment v = (VariableDeclarationFragment) fr;
          // A final field with an initializer is no constructor's to set.
          if (Modifier.isFinal(f.getModifiers()) && v.getInitializer() != null) continue;
          all.add(new Member(f.getType().toString(), v.getName().getIdentifier(), !Modifier.isFinal(f.getModifiers())));
        }
      }
    }
    Set<String> methods = new HashSet<>();
    List<String> ctorTypes = null;
    for (Object d : type.bodyDeclarations()) {
      if (!(d instanceof MethodDeclaration m)) continue;
      methods.add(m.getName().getIdentifier() + "/" + m.parameters().size());
      List<String> types = new ArrayList<>();
      for (Object p : m.parameters()) types.add(((SingleVariableDeclaration) p).getType().toString());
      if (m.isConstructor() && types.equals(all.stream().map(Member::type).toList())) ctorTypes = types;
    }
    if (!record && o.style().equals("copy") && ctorTypes == null)
      return Builders.Result.refuse(cu, "batlehub: " + t + " has no constructor taking every field ("
          + String.join(", ", all.stream().map(Member::type).toList()) + "): generate one first with Generate ▸ Constructors…");

    ASTRewrite rewrite = ASTRewrite.create(cu.getAST());
    ListRewrite body = rewrite.getListRewrite(type, type.getBodyDeclarationsProperty());
    int added = 0;
    for (Member m : all) {
      if (o.fields() != null && !o.fields().contains(m.name())) continue;
      if (o.style().equals("mutate") && !m.assignable()) continue;
      String name = Builders.method(o.methodPrefix(), m.name());
      if (methods.contains(name + "/1")) continue;
      String result = o.style().equals("mutate")
          ? "this." + m.name() + " = " + m.name() + ";\n" + indent + "return this;"
          : "return new " + t + "(" + String.join(", ", all.stream().map(x -> x == m ? x.name() : "this." + x.name()).toList()) + ");";
      body.insertLast(rewrite.createStringPlaceholder("public " + t + " " + name + "(" + m.type() + " " + m.name() + ") {\n" + indent + result + "\n}", ASTNode.METHOD_DECLARATION), null);
      added++;
    }
    if (added == 0 && o.style().equals("mutate") && all.stream().noneMatch(Member::assignable))
      return Builders.Result.refuse(cu, "batlehub: every field of " + t + " is final: use the copy style");
    return new Builders.Result(rewrite, null, null, null);
  }
}
