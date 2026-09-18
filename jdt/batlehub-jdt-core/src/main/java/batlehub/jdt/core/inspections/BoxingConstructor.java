package batlehub.jdt.core.inspections;

import batlehub.jdt.core.Finding;
import java.util.List;
import java.util.Set;
import org.eclipse.jdt.core.dom.AST;
import org.eclipse.jdt.core.dom.ASTVisitor;
import org.eclipse.jdt.core.dom.ClassInstanceCreation;
import org.eclipse.jdt.core.dom.CompilationUnit;
import org.eclipse.jdt.core.dom.MethodInvocation;

/** `new Integer(x)` (deprecated for removal) → `Integer.valueOf(x)`. */
public final class BoxingConstructor extends Base {
  private static final Set<String> BOXES = Set.of("Boolean", "Byte", "Short", "Integer", "Long", "Float", "Double", "Character");

  public BoxingConstructor() {
    super("performance", "boxingConstructor", "warning");
  }

  @Override
  public void visit(CompilationUnit cu, List<Finding> out) {
    cu.accept(new ASTVisitor() {
      @Override
      public boolean visit(ClassInstanceCreation c) {
        String t = c.getType().toString();
        if (!BOXES.contains(t) || c.arguments().size() != 1 || c.getAnonymousClassDeclaration() != null) return true;
        out.add(new Finding(BoxingConstructor.this, c, "new " + t + "(…) is deprecated for removal: use " + t + ".valueOf(…)", "Replace with " + t + ".valueOf(…)", rw -> {
          AST ast = c.getAST();
          MethodInvocation m = ast.newMethodInvocation();
          m.setExpression(ast.newSimpleName(t));
          m.setName(ast.newSimpleName("valueOf"));
          m.arguments().add(rw.createCopyTarget((org.eclipse.jdt.core.dom.ASTNode) c.arguments().get(0)));
          rw.replace(c, m, null);
        }));
        return true;
      }
    });
  }
}
