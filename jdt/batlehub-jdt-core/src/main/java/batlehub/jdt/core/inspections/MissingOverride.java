package batlehub.jdt.core.inspections;

import batlehub.jdt.core.Finding;
import java.util.List;
import org.eclipse.jdt.core.dom.AST;
import org.eclipse.jdt.core.dom.ASTVisitor;
import org.eclipse.jdt.core.dom.Annotation;
import org.eclipse.jdt.core.dom.CompilationUnit;
import org.eclipse.jdt.core.dom.MarkerAnnotation;
import org.eclipse.jdt.core.dom.MethodDeclaration;
import org.eclipse.jdt.core.dom.rewrite.ListRewrite;

/** `toString()`, `hashCode()`, `equals(Object)` without `@Override` — the three every class inherits, decidable without bindings. */
public final class MissingOverride extends Base {
  public MissingOverride() {
    super("correctness", "missingOverride", "warning");
  }

  @Override
  public void visit(CompilationUnit cu, List<Finding> out) {
    cu.accept(new ASTVisitor() {
      @Override
      public boolean visit(MethodDeclaration m) {
        String n = m.getName().getIdentifier();
        int p = m.parameters().size();
        boolean inherited = (n.equals("toString") || n.equals("hashCode")) && p == 0 || n.equals("equals") && p == 1;
        if (!inherited || m.isConstructor()) return false;
        for (Object mod : m.modifiers()) if (mod instanceof Annotation a && a.getTypeName().getFullyQualifiedName().endsWith("Override")) return false;
        out.add(new Finding(MissingOverride.this, m.getName(), "'" + n + "' overrides Object's and lacks @Override", "Add @Override", rw -> {
          AST ast = m.getAST();
          MarkerAnnotation ann = ast.newMarkerAnnotation();
          ann.setTypeName(ast.newSimpleName("Override"));
          ListRewrite mods = rw.getListRewrite(m, MethodDeclaration.MODIFIERS2_PROPERTY);
          mods.insertFirst(ann, null);
        }));
        return false;
      }
    });
  }
}
